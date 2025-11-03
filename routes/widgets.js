// routes/widgets.js
const express = require('express');
const router = express.Router();
const database = require('../config/database');
const { protect } = require('../middleware/auth');

if (typeof protect !== 'function') {
  console.error('ERROR: protect middleware is not a function. Check ../middleware/auth.js export.');
  throw new Error('Auth middleware not found (protect)');
}

// GET /api/widgets/user-dashboard
// Get the company dashboard for logged in user
router.get('/user-dashboard', protect, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const userRole = req.user.role;

    const dashboardQuery = `
      SELECT d.*, c.name as company_name
      FROM dashboards d
      INNER JOIN "user" u ON d.created_by = u.id
      INNER JOIN company c ON u.company_id = c.id
      WHERE c.id = $1 AND d.is_active = true
      ORDER BY d.created_at ASC
      LIMIT 1
    `;

    const dashboardResult = await database.query(dashboardQuery, [companyId]);

    if (dashboardResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          dashboard: null,
          widgets: [],
          message: 'No dashboard configured for your company yet'
        }
      });
    }

    const dashboard = dashboardResult.rows[0];

    const widgetsQuery = `
      SELECT
        dl.id as layout_id,
        dl.layout_config,
        dl.instance_config,
        dl.display_order,
        wd.id as widget_id,
        wd.name as widget_name,
        wd.description as widget_description,
        wd.data_source_config,
        wt.name as widget_type,
        wt.component_name,
        wt.default_config as widget_default_config
      FROM dashboard_layouts dl
      INNER JOIN widget_definitions wd ON dl.widget_definition_id = wd.id
      INNER JOIN widget_types wt ON wd.widget_type_id = wt.id
      WHERE dl.dashboard_id = $1
      ORDER BY dl.display_order ASC
    `;

    const widgetsResult = await database.query(widgetsQuery, [dashboard.id]);

    res.json({
      success: true,
      data: {
        dashboard: {
          id: dashboard.id,
          name: dashboard.name,
          description: dashboard.description,
          gridConfig: dashboard.grid_config,
          version: dashboard.version,
          companyName: dashboard.company_name,
          canEdit: userRole === 'admin'
        },
        widgets: widgetsResult.rows.map(widget => ({
          layoutId: widget.layout_id,
          widgetId: widget.widget_id,
          name: widget.widget_name,
          description: widget.widget_description,
          type: widget.widget_type,
          component: widget.component_name,
          layoutConfig: widget.layout_config,
          dataSourceConfig: widget.data_source_config,
          instanceConfig: widget.instance_config,
          defaultConfig: widget.widget_default_config,
          displayOrder: widget.display_order
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching user dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard',
      error: error.message
    });
  }
});

// GET /api/widgets/available-widgets
// Get available widgets by device type for admin to choose from
router.get('/available-widgets', protect, async (req, res) => {
  try {
    const { deviceTypeId } = req.query;

    if (!deviceTypeId) {
      return res.status(400).json({
        success: false,
        message: 'deviceTypeId is required'
      });
    }

    const deviceTypeResult = await database.query(
      'SELECT id, type_name FROM device_type WHERE id = $1',
      [deviceTypeId]
    );

    if (deviceTypeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device type not found'
      });
    }

    const widgetTypesResult = await database.query(
      'SELECT id, name, component_name, default_config FROM widget_types ORDER BY name'
    );

    const propertiesResult = await database.query(
      `SELECT id, variable_name, variable_tag, data_type, unit, ui_order
       FROM device_data_mapping
       WHERE device_type_id = $1
       ORDER BY ui_order, variable_name`,
      [deviceTypeId]
    );

    res.json({
      success: true,
      data: {
        deviceType: deviceTypeResult.rows[0],
        widgetTypes: widgetTypesResult.rows.map(wt => ({
          id: wt.id,
          name: wt.name,
          componentName: wt.component_name,
          defaultConfig: wt.default_config,
          displayName: wt.name === 'line_chart' ? 'Line Chart' :
                       wt.name === 'kpi' ? 'KPI Card' :
                       wt.name === 'donut_chart' ? 'Donut Chart' :
                       wt.name === 'map' ? 'Map' : wt.name
        })),
        properties: propertiesResult.rows.map(p => ({
          id: p.id,
          name: p.variable_name,
          tag: p.variable_tag,
          dataType: p.data_type,
          unit: p.unit,
          order: p.ui_order
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching available widgets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available widgets',
      error: error.message
    });
  }
});

// GET /api/widgets/device-types
// Get all device types for admin
router.get('/device-types', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can access this endpoint'
      });
    }

    const result = await database.query(
      'SELECT id, type_name, logo FROM device_type ORDER BY type_name'
    );

    res.json({
      success: true,
      data: result.rows.map(dt => ({
        id: dt.id,
        typeName: dt.type_name,
        logo: dt.logo
      }))
    });
  } catch (error) {
    console.error('Error fetching device types:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch device types',
      error: error.message
    });
  }
});

// POST /api/widgets/create-widget
// Admin creates a custom widget by selecting device type, widget type, and properties
router.post('/create-widget', protect, async (req, res) => {
  const client = await database.pool.connect();
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can create widgets'
      });
    }

    const { deviceTypeId, widgetTypeId, propertyIds, displayName } = req.body;

    if (!deviceTypeId || !widgetTypeId || !propertyIds || propertyIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'deviceTypeId, widgetTypeId, and propertyIds array are required'
      });
    }

    await client.query('BEGIN');

    const seriesConfig = [];
    for (const propId of propertyIds) {
      const mappingResult = await client.query(
        `SELECT id, variable_name, variable_tag, unit, data_type
         FROM device_data_mapping
         WHERE id = $1 AND device_type_id = $2`,
        [propId, deviceTypeId]
      );

      if (mappingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Property with ID ${propId} not found for device type ${deviceTypeId}`
        });
      }

      const mapping = mappingResult.rows[0];
      seriesConfig.push({
        propertyId: mapping.id,
        propertyName: mapping.variable_name,
        displayName: mapping.variable_name,
        dataSourceProperty: mapping.variable_tag,
        unit: mapping.unit,
        dataType: mapping.data_type
      });
    }

    const dataSourceConfig = {
      deviceTypeId: parseInt(deviceTypeId),
      numberOfSeries: propertyIds.length,
      seriesConfig: seriesConfig
    };

    const widgetName = displayName || `${seriesConfig.map(s => s.displayName).join(', ')} Chart`;
    const widgetResult = await client.query(
      `INSERT INTO widget_definitions (name, description, widget_type_id, data_source_config, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        widgetName,
        `Custom widget showing ${seriesConfig.map(s => s.displayName).join(', ')} for device type ${deviceTypeId}`,
        widgetTypeId,
        JSON.stringify(dataSourceConfig),
        req.user.id
      ]
    );

    const widgetId = widgetResult.rows[0].id;

    const dashboardResult = await client.query(
      `SELECT d.id
       FROM dashboards d
       INNER JOIN "user" u ON d.created_by = u.id
       WHERE u.company_id = $1 AND d.is_active = true
       ORDER BY d.created_at ASC
       LIMIT 1`,
      [req.user.company_id]
    );

    if (dashboardResult.rows.length > 0) {
      const dashboardId = dashboardResult.rows[0].id;

      const maxOrderResult = await client.query(
        'SELECT COALESCE(MAX(display_order), 0) as max_order FROM dashboard_layouts WHERE dashboard_id = $1',
        [dashboardId]
      );
      const nextOrder = maxOrderResult.rows[0].max_order + 1;

      await client.query(
        `INSERT INTO dashboard_layouts (dashboard_id, widget_definition_id, layout_config, display_order)
         VALUES ($1, $2, $3, $4)`,
        [
          dashboardId,
          widgetId,
          JSON.stringify({ x: 0, y: 0, w: 6, h: 3, minW: 3, minH: 2, static: false }),
          nextOrder
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        widgetId,
        dataSourceConfig,
        widgetName
      },
      message: 'Widget created and added to dashboard successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating widget:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create widget',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// POST /api/widgets/add-to-dashboard
// Admin adds widget to dashboard
router.post('/add-to-dashboard', protect, async (req, res) => {
  const client = await database.pool.connect();
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can add widgets to dashboard'
      });
    }

    const { widgetDefinitionId, layoutConfig } = req.body;

    if (!widgetDefinitionId) {
      return res.status(400).json({
        success: false,
        message: 'widgetDefinitionId is required'
      });
    }

    await client.query('BEGIN');

    const dashboardResult = await client.query(
      `SELECT d.id
       FROM dashboards d
       INNER JOIN "user" u ON d.created_by = u.id
       WHERE u.company_id = $1 AND d.is_active = true
       ORDER BY d.created_at ASC
       LIMIT 1`,
      [req.user.company_id]
    );

    if (dashboardResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'No active dashboard found for your company'
      });
    }

    const dashboardId = dashboardResult.rows[0].id;

    const maxOrderResult = await client.query(
      'SELECT COALESCE(MAX(display_order), 0) as max_order FROM dashboard_layouts WHERE dashboard_id = $1',
      [dashboardId]
    );
    const nextOrder = maxOrderResult.rows[0].max_order + 1;

    const result = await client.query(
      `INSERT INTO dashboard_layouts (dashboard_id, widget_definition_id, layout_config, display_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        dashboardId,
        widgetDefinitionId,
        JSON.stringify(layoutConfig || { x: 0, y: 0, w: 4, h: 2, minW: 2, minH: 1, static: false }),
        nextOrder
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      data: {
        layoutId: result.rows[0].id,
        dashboardId
      },
      message: 'Widget added to dashboard successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding widget to dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add widget to dashboard',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// DELETE /api/widgets/remove-widget/:layoutId
// Admin removes widget from dashboard
router.delete('/remove-widget/:layoutId', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can remove widgets'
      });
    }

    const { layoutId } = req.params;

    const result = await database.query(
      'DELETE FROM dashboard_layouts WHERE id = $1 RETURNING id',
      [layoutId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Widget not found'
      });
    }

    res.json({
      success: true,
      message: 'Widget removed successfully'
    });
  } catch (error) {
    console.error('Error removing widget:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove widget',
      error: error.message
    });
  }
});

// POST /api/widgets/update-layout
// Admin updates widget positions on dashboard
router.post('/update-layout', protect, async (req, res) => {
  const client = await database.pool.connect();
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can update layout'
      });
    }

    const { layouts } = req.body;

    if (!Array.isArray(layouts)) {
      return res.status(400).json({
        success: false,
        message: 'layouts must be an array'
      });
    }

    await client.query('BEGIN');

    for (const layout of layouts) {
      const { layoutId, layoutConfig } = layout;
      await client.query(
        'UPDATE dashboard_layouts SET layout_config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [JSON.stringify(layoutConfig), layoutId]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Layout updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating layout:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update layout',
      error: error.message
    });
  } finally {
    client.release();
  }
});





// GET /api/widgets/widget-data/:widgetId
// Get widget data based on its configuration from data_source_config
// Supports hierarchy and device filtering
router.get('/widget-data/:widgetId', protect, async (req, res) => {
  try {
    const { widgetId } = req.params;
    const { limit = 200, timeRange = '24h', hierarchyId, deviceId } = req.query;
    const companyId = req.user.company_id;

    console.log(`[WIDGET DATA] Fetching data for widget ${widgetId}, timeRange: ${timeRange}, hierarchyId: ${hierarchyId}, deviceId: ${deviceId}`);

    const widgetResult = await database.query(
      `SELECT wd.data_source_config, wt.component_name, wt.name as widget_type
       FROM widget_definitions wd
       INNER JOIN widget_types wt ON wd.widget_type_id = wt.id
       WHERE wd.id = $1`,
      [widgetId]
    );

    if (widgetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Widget not found'
      });
    }

    const widget = widgetResult.rows[0];
    const dataSourceConfig = widget.data_source_config;

    console.log('[WIDGET DATA] Widget config:', JSON.stringify(dataSourceConfig, null, 2));

    if (!dataSourceConfig.seriesConfig || dataSourceConfig.seriesConfig.length === 0) {
      return res.json({
        success: true,
        data: {},
        config: dataSourceConfig,
        message: 'No series configured'
      });
    }

    let timeFilter = '';
    if (timeRange === '1h') timeFilter = "AND dd.created_at >= NOW() - INTERVAL '1 hour'";
    else if (timeRange === '6h') timeFilter = "AND dd.created_at >= NOW() - INTERVAL '6 hours'";
    else if (timeRange === '24h') timeFilter = "AND dd.created_at >= NOW() - INTERVAL '24 hours'";
    else if (timeRange === '7d') timeFilter = "AND dd.created_at >= NOW() - INTERVAL '7 days'";
    else if (timeRange === '30d') timeFilter = "AND dd.created_at >= NOW() - INTERVAL '30 days'";

    // Build device filter based on hierarchy or device selection
    let deviceFilterJoin = '';
    let deviceFilterWhere = '';
    let hasFilter = false;
    const baseParams = [companyId, dataSourceConfig.deviceTypeId, parseInt(limit)];

    if (hierarchyId) {
      // Recursive CTE to find all devices under hierarchy
      console.log(`[WIDGET DATA] Applying hierarchy filter: ${hierarchyId}`);
      deviceFilterJoin = `
        WITH RECURSIVE hierarchy_tree AS (
          SELECT id FROM hierarchy WHERE id = $4
          UNION ALL
          SELECT h.id FROM hierarchy h
          JOIN hierarchy_tree ht ON h.parent_id = ht.id
        )
      `;
      deviceFilterWhere = `AND d.hierarchy_id IN (SELECT id FROM hierarchy_tree)`;
      hasFilter = true;
    } else if (deviceId) {
      // Single device filter
      console.log(`[WIDGET DATA] Applying device filter: ${deviceId}`);
      deviceFilterWhere = `AND d.id = $4`;
      hasFilter = true;
    }

    const seriesData = {};

    for (const s of dataSourceConfig.seriesConfig) {
      console.log(`[WIDGET DATA] Loading series: ${s.displayName}, property: ${s.dataSourceProperty}, deviceTypeId: ${dataSourceConfig.deviceTypeId}`);

      // Calculate parameter index: if we have a filter (hierarchy/device), dataSourceProperty is at position 5
      // If no filter, it's at position 4
      const paramIndex = hasFilter ? 5 : 4;

      const seriesQuery = `
        ${deviceFilterJoin}
        SELECT
          dd.created_at as timestamp,
          dd.serial_number,
          COALESCE((dd.data->>$${paramIndex})::numeric, 0) as value
        FROM device_data dd
        INNER JOIN device d ON dd.device_id = d.id
        WHERE d.company_id = $1
          AND d.device_type_id = $2
          ${deviceFilterWhere}
          ${timeFilter}
          AND dd.data ? $${paramIndex}
        ORDER BY dd.created_at ASC
        LIMIT $3
      `;

      // Build seriesParams with correct parameter order:
      // $1: companyId, $2: deviceTypeId, $3: limit, $4: hierarchyId/deviceId (if filter exists), $5: dataSourceProperty
      const seriesParams = hasFilter
        ? [companyId, dataSourceConfig.deviceTypeId, parseInt(limit),
           parseInt(hierarchyId || deviceId), s.dataSourceProperty]
        : [companyId, dataSourceConfig.deviceTypeId, parseInt(limit), s.dataSourceProperty];

      const seriesResult = await database.query(seriesQuery, seriesParams);

      console.log(`[WIDGET DATA] Series ${s.displayName} returned ${seriesResult.rows.length} data points`);

      seriesData[s.displayName] = {
        data: seriesResult.rows.map(row => ({
          timestamp: row.timestamp,
          serialNumber: row.serial_number,
          value: parseFloat(row.value) || 0
        })),
        unit: s.unit || '',
        propertyName: s.propertyName
      };
    }

    console.log(`[WIDGET DATA] Returning data with ${Object.keys(seriesData).length} series`);

    res.json({
      success: true,
      data: seriesData,
      config: dataSourceConfig,
      context: {
        hierarchyId: hierarchyId || null,
        deviceId: deviceId || null,
        timeRange
      }
    });
  } catch (error) {
    console.error('Error fetching widget data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch widget data',
      error: error.message
    });
  }
});

// GET /api/widgets/widget-data/:widgetId/latest
// Get latest widget data from device_latest
router.get('/widget-data/:widgetId/latest', protect, async (req, res) => {
  try {
    const { widgetId } = req.params;
    const companyId = req.user.company_id;

    const widgetResult = await database.query(
      `SELECT wd.data_source_config, wt.component_name
       FROM widget_definitions wd
       INNER JOIN widget_types wt ON wd.widget_type_id = wt.id
       WHERE wd.id = $1`,
      [widgetId]
    );

    if (widgetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Widget not found'
      });
    }

    const widget = widgetResult.rows[0];
    const dataSourceConfig = widget.data_source_config;

    if (!dataSourceConfig.seriesConfig || dataSourceConfig.seriesConfig.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No series configured'
      });
    }

    const seriesData = {};
    for (const s of dataSourceConfig.seriesConfig) {
      const query = `
        SELECT
          dl.updated_at as timestamp,
          dl.serial_number,
          dl.data->>$1 as value,
          d.metadata->>'location' as location,
          dt.type_name as device_type
        FROM device_latest dl
        INNER JOIN device d ON dl.device_id = d.id
        INNER JOIN device_type dt ON d.device_type_id = dt.id
        WHERE d.company_id = $2
          AND d.device_type_id = $3
        ORDER BY dl.updated_at DESC
      `;
      const params = [s.dataSourceProperty, companyId, dataSourceConfig.deviceTypeId];
      const dataResult = await database.query(query, params);

      const formattedData = dataResult.rows.map(row => ({
        timestamp: row.timestamp,
        serialNumber: row.serial_number,
        value: parseFloat(row.value) || 0,
        location: row.location,
        deviceType: row.device_type
      }));

      let aggregatedValue = null;
      if (formattedData.length > 0) {
        const sum = formattedData.reduce((acc, item) => acc + item.value, 0);
        aggregatedValue = sum / formattedData.length;
      }

      seriesData[s.displayName] = {
        latest: formattedData,
        aggregatedValue,
        count: formattedData.length,
        unit: s.unit
      };
    }

    res.json({
      success: true,
      data: seriesData,
      config: dataSourceConfig
    });
  } catch (error) {
    console.error('Error fetching latest widget data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch latest widget data',
      error: error.message
    });
  }
});


module.exports = router;
