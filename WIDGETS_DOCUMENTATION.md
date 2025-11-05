# Widgets System Documentation

## Table of Contents
1. [Code Review of widgets.js](#code-review-of-widgetsjs)
2. [Data Loading Logic](#data-loading-logic)
3. [Database Queries Analysis](#database-queries-analysis)
4. [Widget Types and Their Data Sources](#widget-types-and-their-data-sources)
5. [Postman Testing Guide](#postman-testing-guide)

---

## Code Review of widgets.js

### File Structure Overview
**Location:** `routes/widgets.js`

### Key Components

#### 1. Middleware and Dependencies
```javascript
const express = require('express');
const router = express.Router();
const database = require('../config/database');
const { protect } = require('../middleware/auth');
```

- Uses Express router for API endpoints
- PostgreSQL database connection via custom database module
- JWT authentication middleware for all protected routes
- All endpoints require authentication via `protect` middleware

#### 2. Route Architecture

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/user-dashboard` | GET | Required | Get company dashboard for logged-in user |
| `/available-widgets` | GET | Required | Get available widgets by device type |
| `/device-types` | GET | Admin | Get all device types |
| `/create-widget` | POST | Admin | Create custom widget |
| `/add-to-dashboard` | POST | Admin | Add widget to dashboard |
| `/remove-widget/:layoutId` | DELETE | Admin | Remove widget from dashboard |
| `/update-layout` | POST | Admin | Update widget positions |
| `/widget-data/:widgetId` | GET | Required | Get widget data (time-series) |
| `/widget-data/:widgetId/latest` | GET | Required | Get latest widget data |

---

## Data Loading Logic

### 1. Dashboard Loading Flow

#### Step 1: User Dashboard Request
```
GET /api/widgets/user-dashboard
Headers: Authorization: Bearer <token>
```

**Process Flow:**
```
1. Extract company_id from authenticated user (req.user.company_id)
2. Query dashboards table for active dashboard
3. Join with company table to get company name
4. Query dashboard_layouts with widget definitions
5. Join widget_types to get component information
6. Return dashboard + widgets array
```

**SQL Query:**
```sql
-- Dashboard Query
SELECT d.*, c.name as company_name
FROM dashboards d
INNER JOIN "user" u ON d.created_by = u.id
INNER JOIN company c ON u.company_id = c.id
WHERE c.id = $1 AND d.is_active = true
ORDER BY d.created_at ASC
LIMIT 1

-- Widgets Query
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
```

**Response Structure:**
```json
{
  "success": true,
  "data": {
    "dashboard": {
      "id": "uuid",
      "name": "MPFM Production Dashboard",
      "description": "Main production dashboard",
      "gridConfig": {},
      "version": 1,
      "companyName": "Arabco",
      "canEdit": false
    },
    "widgets": [
      {
        "layoutId": "uuid",
        "widgetId": "uuid",
        "name": "OFR Chart",
        "type": "line_chart",
        "component": "CustomLineChart",
        "layoutConfig": { "x": 0, "y": 2, "w": 4, "h": 3 },
        "dataSourceConfig": {
          "deviceTypeId": 1,
          "numberOfSeries": 1,
          "seriesConfig": [...]
        },
        "displayOrder": 5
      }
    ]
  }
}
```

### 2. Widget Data Loading Flow

#### Step 2: Load Data for Each Widget
```
GET /api/widgets/widget-data/:widgetId?timeRange=24h&hierarchyId=1&deviceId=25
```

**Process Flow:**
```
1. Extract widgetId from URL parameters
2. Extract filters: timeRange, hierarchyId, deviceId from query params
3. Query widget_definitions to get data_source_config
4. Parse seriesConfig from data_source_config
5. For each series in seriesConfig:
   - Build SQL query with device filter (hierarchy or device)
   - Apply time filter based on timeRange
   - Query device_data table
6. Transform and return data for each series
```

**SQL Query (with hierarchy filter):**
```sql
-- Recursive CTE for hierarchy filtering
WITH RECURSIVE hierarchy_tree AS (
  SELECT id FROM hierarchy WHERE id = $4
  UNION ALL
  SELECT h.id FROM hierarchy h
  JOIN hierarchy_tree ht ON h.parent_id = ht.id
)
SELECT
  dd.created_at as timestamp,
  dd.serial_number,
  COALESCE((dd.data->>$5)::numeric, 0) as value
FROM device_data dd
INNER JOIN device d ON dd.device_id = d.id
WHERE d.company_id = $1
  AND d.device_type_id = $2
  AND d.hierarchy_id IN (SELECT id FROM hierarchy_tree)
  AND dd.created_at >= NOW() - INTERVAL '24 hours'
  AND dd.data ? $5
ORDER BY dd.created_at ASC
LIMIT $3
```

**Parameters:**
- `$1`: companyId
- `$2`: deviceTypeId (from widget's data_source_config)
- `$3`: limit (default 200)
- `$4`: hierarchyId (for filtering by location)
- `$5`: dataSourceProperty (e.g., 'OFR', 'WFR', 'GFR')

**Response Structure:**
```json
{
  "success": true,
  "data": {
    "OFR": {
      "data": [
        {
          "timestamp": "2025-11-03T10:00:00Z",
          "serialNumber": "MPFM-ARB-101",
          "value": 850.5
        }
      ],
      "unit": "l/min",
      "propertyName": "Oil Flow Rate"
    }
  },
  "config": {
    "deviceTypeId": 1,
    "numberOfSeries": 1,
    "seriesConfig": [...]
  },
  "context": {
    "hierarchyId": 1,
    "deviceId": null,
    "timeRange": "24h"
  }
}
```

---

## Database Queries Analysis

### Query Performance Considerations

#### 1. Dashboard Loading Query
**Performance:** ⭐⭐⭐⭐⭐ Excellent
- Uses indexed foreign keys (created_by, company_id)
- Simple JOIN operations
- Returns only one dashboard per company
- Result set is small (10 widgets max per dashboard)

**Indexes Used:**
- `dashboards(created_by)` - FK index
- `dashboards(is_active)` - Filter index
- `company(id)` - PK index

#### 2. Widget Data Loading Query
**Performance:** ⭐⭐⭐⭐ Good (with optimizations)

**Optimization Strategies:**
1. **Time-based Partitioning:** `device_data` table uses BRIN index on `created_at`
2. **Hierarchy Filtering:** Recursive CTE is efficient for hierarchical data
3. **JSONB Indexing:** GIN index on `device_data.data` for property existence check
4. **Limit Control:** Default 200 rows prevents excessive data transfer

**Query Plan Analysis:**
```
Limit (cost=X..Y rows=200)
  -> Nested Loop (cost=X..Y)
    -> CTE Scan on hierarchy_tree (cost=X..Y)
    -> Index Scan using device_company_idx on device (cost=X..Y)
    -> Bitmap Heap Scan on device_data (cost=X..Y)
      -> Bitmap Index Scan using brin_device_data_created_at (cost=X..Y)
      -> Index Scan using gin_device_data_data (cost=X..Y)
```

#### 3. Latest Data Query
**Performance:** ⭐⭐⭐⭐⭐ Excellent
- Uses `device_latest` table (materialized view concept)
- One row per device
- No time-based filtering needed
- Near-instant response

**Query:**
```sql
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
```

---

## Widget Types and Their Data Sources

### 1. KPI Widgets (MetricsCard)

**Type:** `kpi`
**Component:** `MetricsCard`

**Data Source Configuration:**
```json
{
  "metric": "ofr",
  "unit": "l/min",
  "title": "Oil flow rate",
  "shortTitle": "OFR",
  "icon": "/oildark.png",
  "colorDark": "#4D3DF7",
  "colorLight": "#F56C44"
}
```

**Supported Metrics:**
- `ofr` - Oil Flow Rate
- `wfr` - Water Flow Rate
- `gfr` - Gas Flow Rate
- `last_refresh` - System refresh timestamp

**Data Loading:**
- Loads latest value from `device_latest` table
- Calculates aggregate across all company devices
- Updates every 5 seconds (frontend polling)

### 2. Line Chart Widgets (CustomLineChart)

**Type:** `line_chart`
**Component:** `CustomLineChart`

**Data Source Configuration:**
```json
{
  "deviceTypeId": 1,
  "numberOfSeries": 1,
  "seriesConfig": [
    {
      "propertyId": 4,
      "propertyName": "Oil Flow Rate",
      "displayName": "OFR",
      "dataSourceProperty": "OFR",
      "unit": "l/min",
      "dataType": "numeric"
    }
  ]
}
```

**Data Loading:**
- Queries `device_data` table with time range filter
- Supports single or multiple series (e.g., OFR only vs GVF+WLR)
- Aggregates data by time period (minute/hour/day based on range)
- Can filter by hierarchy or specific device

**Time Range Options:**
- `1h` - Last 1 hour
- `6h` - Last 6 hours
- `24h` - Last 24 hours (default)
- `7d` - Last 7 days
- `30d` - Last 30 days

### 3. Donut Chart Widgets (GVFWLRChart)

**Type:** `donut_chart`
**Component:** `GVFWLRChart`

**Data Source Configuration:**
```json
{
  "metrics": ["gvf", "wlr"],
  "title": "GVF/WLR"
}
```

**Data Loading:**
- Loads latest values for GVF and WLR
- Calculates percentage representation
- Uses `device_latest` for real-time data

### 4. Map Widgets (ProductionMap)

**Type:** `map`
**Component:** `ProductionMap`

**Data Source Configuration:**
```json
{
  "showDevices": true,
  "showStatistics": true
}
```

**Data Loading:**
- Queries device locations from `device_latest` table
- Loads longitude/latitude coordinates
- Fetches device status (online/offline)
- Shows device metadata on hover

---

## Postman Testing Guide

### Collection: 10. Widget Management API

#### Setup Variables
```json
{
  "baseUrl": "http://localhost:5000",
  "authToken": "",
  "adminToken": "",
  "arabcoToken": "",
  "defaultDashboardId": "",
  "widgetId": "",
  "layoutId": ""
}
```

---

### Test Case 1: Admin Login and Dashboard Access

#### Request 1.1: Login as Admin
```
POST {{baseUrl}}/api/auth/login
Content-Type: application/json

{
  "email": "admin@saherflow.com",
  "password": "Admin123"
}
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGc...",
    "user": {
      "id": 1,
      "email": "admin@saherflow.com",
      "role": "admin",
      "company_id": 2
    }
  }
}
```

**Post-Response Script:**
```javascript
pm.test("Admin login successful", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data.user.role).to.eql("admin");
    pm.environment.set("adminToken", jsonData.data.token);
});
```

#### Request 1.2: Get Admin Dashboard
```
GET {{baseUrl}}/api/widgets/user-dashboard
Authorization: Bearer {{adminToken}}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "dashboard": {
      "id": "uuid",
      "name": "MPFM Production Dashboard",
      "companyName": "Saher Flow",
      "canEdit": true
    },
    "widgets": [
      {
        "layoutId": "uuid",
        "widgetId": "uuid",
        "name": "OFR Metric",
        "type": "kpi",
        "component": "MetricsCard",
        "layoutConfig": {"x": 0, "y": 0, "w": 3, "h": 2},
        "displayOrder": 1
      }
    ]
  }
}
```

**Test Script:**
```javascript
pm.test("Dashboard loaded successfully", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.dashboard).to.exist;
    pm.expect(jsonData.data.widgets).to.be.an("array");
    pm.expect(jsonData.data.dashboard.canEdit).to.be.true;
    pm.environment.set("defaultDashboardId", jsonData.data.dashboard.id);
    if (jsonData.data.widgets.length > 0) {
        pm.environment.set("widgetId", jsonData.data.widgets[0].widgetId);
        pm.environment.set("layoutId", jsonData.data.widgets[0].layoutId);
    }
});
```

---

### Test Case 2: Regular User Login and Dashboard Access

#### Request 2.1: Login as Arabco User
```
POST {{baseUrl}}/api/auth/login
Content-Type: application/json

{
  "email": "john@arabco.com",
  "password": "Password123"
}
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGc...",
    "user": {
      "id": 3,
      "email": "john@arabco.com",
      "role": "user",
      "company_id": 1
    }
  }
}
```

**Post-Response Script:**
```javascript
pm.test("User login successful", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data.user.role).to.eql("user");
    pm.environment.set("arabcoToken", jsonData.data.token);
});
```

#### Request 2.2: Get User Dashboard
```
GET {{baseUrl}}/api/widgets/user-dashboard
Authorization: Bearer {{arabcoToken}}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "dashboard": {
      "id": "uuid",
      "name": "MPFM Production Dashboard",
      "companyName": "Arabco",
      "canEdit": false
    },
    "widgets": [...]
  }
}
```

**Test Script:**
```javascript
pm.test("User dashboard loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.dashboard.canEdit).to.be.false;
    pm.expect(jsonData.data.dashboard.companyName).to.eql("Arabco");
});
```

---

### Test Case 3: Widget Data Loading (All Widget Types)

#### Request 3.1: Load OFR Chart Data (24h range)
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=24h&limit=200
Authorization: Bearer {{arabcoToken}}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "OFR": {
      "data": [
        {
          "timestamp": "2025-11-03T10:00:00.000Z",
          "serialNumber": "MPFM-ARB-101",
          "value": 850.5
        }
      ],
      "unit": "l/min",
      "propertyName": "Oil Flow Rate"
    }
  },
  "config": {
    "deviceTypeId": 1,
    "numberOfSeries": 1,
    "seriesConfig": [...]
  },
  "context": {
    "hierarchyId": null,
    "deviceId": null,
    "timeRange": "24h"
  }
}
```

**Test Script:**
```javascript
pm.test("Widget data loaded successfully", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
    pm.expect(jsonData.data).to.be.an("object");

    const series = Object.keys(jsonData.data);
    pm.expect(series.length).to.be.at.least(1);

    series.forEach(seriesName => {
        pm.expect(jsonData.data[seriesName]).to.have.property("data");
        pm.expect(jsonData.data[seriesName].data).to.be.an("array");
        pm.expect(jsonData.data[seriesName]).to.have.property("unit");
    });
});
```

#### Request 3.2: Load Widget Data with Hierarchy Filter
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=24h&hierarchyId=1
Authorization: Bearer {{arabcoToken}}
```

**Test Script:**
```javascript
pm.test("Hierarchy filtered data loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.context.hierarchyId).to.eql("1");
});
```

#### Request 3.3: Load Widget Data with Device Filter
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=24h&deviceId=25
Authorization: Bearer {{arabcoToken}}
```

**Test Script:**
```javascript
pm.test("Device filtered data loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.context.deviceId).to.eql("25");

    // Verify all data points are from the same device
    Object.keys(jsonData.data).forEach(seriesName => {
        const uniqueDevices = [...new Set(
            jsonData.data[seriesName].data.map(d => d.serialNumber)
        )];
        pm.expect(uniqueDevices.length).to.be.at.most(1);
    });
});
```

#### Request 3.4: Load Widget Data (Different Time Ranges)

**1 Hour Range:**
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=1h
Authorization: Bearer {{arabcoToken}}
```

**7 Days Range:**
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=7d
Authorization: Bearer {{arabcoToken}}
```

**30 Days Range:**
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}?timeRange=30d
Authorization: Bearer {{arabcoToken}}
```

**Test Script (Generic for all time ranges):**
```javascript
pm.test("Time range data loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.context.timeRange).to.exist;

    Object.keys(jsonData.data).forEach(seriesName => {
        const dataPoints = jsonData.data[seriesName].data;
        if (dataPoints.length > 0) {
            const timestamps = dataPoints.map(d => new Date(d.timestamp));
            const oldest = Math.min(...timestamps);
            const newest = Math.max(...timestamps);
            console.log(`Data range: ${new Date(oldest)} to ${new Date(newest)}`);
        }
    });
});
```

#### Request 3.5: Load Latest Widget Data
```
GET {{baseUrl}}/api/widgets/widget-data/{{widgetId}}/latest
Authorization: Bearer {{arabcoToken}}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "OFR": {
      "latest": [
        {
          "timestamp": "2025-11-03T12:00:00.000Z",
          "serialNumber": "MPFM-ARB-101",
          "value": 850.5,
          "location": "Ghawar-Well-101",
          "deviceType": "MPFM"
        }
      ],
      "aggregatedValue": 825.3,
      "count": 9,
      "unit": "l/min"
    }
  },
  "config": {...}
}
```

**Test Script:**
```javascript
pm.test("Latest data loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();

    Object.keys(jsonData.data).forEach(seriesName => {
        pm.expect(jsonData.data[seriesName]).to.have.property("latest");
        pm.expect(jsonData.data[seriesName]).to.have.property("aggregatedValue");
        pm.expect(jsonData.data[seriesName]).to.have.property("count");
    });
});
```

---

### Test Case 4: Admin Widget Management

#### Request 4.1: Get Available Widget Types
```
GET {{baseUrl}}/api/widgets/device-types
Authorization: Bearer {{adminToken}}
```

**Test Script:**
```javascript
pm.test("Device types loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data).to.be.an("array");
    pm.expect(jsonData.data.length).to.be.at.least(1);
});
```

#### Request 4.2: Get Available Widgets for Device Type
```
GET {{baseUrl}}/api/widgets/available-widgets?deviceTypeId=1
Authorization: Bearer {{adminToken}}
```

**Test Script:**
```javascript
pm.test("Available widgets loaded", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.widgetTypes).to.be.an("array");
    pm.expect(jsonData.data.properties).to.be.an("array");
});
```

#### Request 4.3: Create Custom Widget
```
POST {{baseUrl}}/api/widgets/create-widget
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "deviceTypeId": 1,
  "widgetTypeId": "{{lineChartTypeId}}",
  "propertyIds": [4, 5],
  "displayName": "OFR + WFR Combined Chart"
}
```

**Test Script:**
```javascript
pm.test("Widget created successfully", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.widgetId).to.exist;
    pm.environment.set("newWidgetId", jsonData.data.widgetId);
});
```

#### Request 4.4: Add Widget to Dashboard
```
POST {{baseUrl}}/api/widgets/add-to-dashboard
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "widgetDefinitionId": "{{newWidgetId}}",
  "layoutConfig": {
    "x": 0,
    "y": 10,
    "w": 6,
    "h": 3,
    "minW": 4,
    "minH": 2,
    "static": false
  }
}
```

**Test Script:**
```javascript
pm.test("Widget added to dashboard", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.data.layoutId).to.exist;
    pm.environment.set("newLayoutId", jsonData.data.layoutId);
});
```

#### Request 4.5: Remove Widget from Dashboard
```
DELETE {{baseUrl}}/api/widgets/remove-widget/{{newLayoutId}}
Authorization: Bearer {{adminToken}}
```

**Test Script:**
```javascript
pm.test("Widget removed successfully", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
});
```

#### Request 4.6: Update Widget Layout
```
POST {{baseUrl}}/api/widgets/update-layout
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "layouts": [
    {
      "layoutId": "{{layoutId}}",
      "layoutConfig": {
        "x": 0,
        "y": 0,
        "w": 4,
        "h": 2,
        "minW": 2,
        "minH": 1,
        "static": false
      }
    }
  ]
}
```

**Test Script:**
```javascript
pm.test("Layout updated successfully", function () {
    pm.response.to.have.status(200);
    const jsonData = pm.response.json();
    pm.expect(jsonData.success).to.be.true;
});
```

---

### Test Case 5: Access Control Tests

#### Request 5.1: Regular User Cannot Access Admin Endpoints
```
GET {{baseUrl}}/api/widgets/device-types
Authorization: Bearer {{arabcoToken}}
```

**Expected Response:**
```json
{
  "success": false,
  "message": "Only admins can access this endpoint"
}
```

**Test Script:**
```javascript
pm.test("User cannot access admin endpoint", function () {
    pm.response.to.have.status(403);
});
```

#### Request 5.2: User Cannot Create Widgets
```
POST {{baseUrl}}/api/widgets/create-widget
Authorization: Bearer {{arabcoToken}}
Content-Type: application/json

{
  "deviceTypeId": 1,
  "widgetTypeId": "uuid",
  "propertyIds": [4]
}
```

**Expected Response:**
```json
{
  "success": false,
  "message": "Only admins can create widgets"
}
```

**Test Script:**
```javascript
pm.test("User cannot create widget", function () {
    pm.response.to.have.status(403);
});
```

---

### Test Case 6: Data Validation Tests

#### Request 6.1: Invalid Widget ID
```
GET {{baseUrl}}/api/widgets/widget-data/invalid-uuid
Authorization: Bearer {{arabcoToken}}
```

**Expected Response:**
```json
{
  "success": false,
  "message": "Widget not found"
}
```

**Test Script:**
```javascript
pm.test("Invalid widget ID handled", function () {
    pm.response.to.have.status(404);
});
```

#### Request 6.2: Missing Required Parameters
```
POST {{baseUrl}}/api/widgets/create-widget
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "deviceTypeId": 1
}
```

**Expected Response:**
```json
{
  "success": false,
  "message": "deviceTypeId, widgetTypeId, and propertyIds array are required"
}
```

**Test Script:**
```javascript
pm.test("Missing parameters detected", function () {
    pm.response.to.have.status(400);
});
```

---

## How OFR Line Chart Data Loading Works (Practical Example)

This section explains step-by-step how data flows into the OFR (Oil Flow Rate) line chart when a user opens the dashboard. This is what you can demonstrate to your supervisor.

### Step 1: User Authentication

The user logs in with their credentials:

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@arabco.com",
  "password": "Password123"
}
```

**Response includes:**
- JWT token (authentication credential)
- User role (admin or user)
- Company ID (required for data filtering)

**Backend logic:** The system validates credentials, generates a JWT token, and stores the company ID in the token for later use.

### Step 2: Dashboard Structure Retrieved

Once authenticated, the user's dashboard is loaded:

```http
GET /api/widgets/user-dashboard
Authorization: Bearer <JWT_TOKEN>
```

**This query retrieves:**
1. Dashboard configuration (name, layout settings)
2. All widgets assigned to this dashboard
3. Widget metadata including the OFR chart widget

**Key information extracted for OFR chart:**
```json
{
  "widgetId": "550e8400-e29b-41d4-a716-446655440000",
  "name": "OFR Chart",
  "type": "line_chart",
  "component": "CustomLineChart",
  "dataSourceConfig": {
    "deviceTypeId": 1,
    "numberOfSeries": 1,
    "seriesConfig": [
      {
        "propertyId": 4,
        "propertyName": "Oil Flow Rate",
        "displayName": "OFR",
        "dataSourceProperty": "OFR",
        "unit": "l/min",
        "dataType": "numeric"
      }
    ]
  }
}
```

**Backend query (dashboard_layouts):**
```sql
SELECT
  dl.id as layout_id,
  dl.layout_config,
  wd.id as widget_id,
  wd.name as widget_name,
  wd.data_source_config,
  wt.component_name
FROM dashboard_layouts dl
INNER JOIN widget_definitions wd ON dl.widget_definition_id = wd.id
INNER JOIN widget_types wt ON wd.widget_type_id = wt.id
WHERE dl.dashboard_id = $1
ORDER BY dl.display_order ASC
```

### Step 3: OFR Chart Data Loading

Once the dashboard is loaded, the OFR chart component requests its data:

```http
GET /api/widgets/widget-data/550e8400-e29b-41d4-a716-446655440000?timeRange=24h
Authorization: Bearer <JWT_TOKEN>
```

**Query parameters:**
- `widgetId`: The specific widget ID from step 2
- `timeRange`: "24h" (can be 1h, 6h, 24h, 7d, 30d)
- `hierarchyId`: Optional - filter by production area/well
- `deviceId`: Optional - filter by specific device

**Backend logic executes a complex query:**

```sql
-- Step 3a: Extract widget configuration
SELECT wd.data_source_config, wt.component_name
FROM widget_definitions wd
INNER JOIN widget_types wt ON wd.widget_type_id = wt.id
WHERE wd.id = '550e8400-e29b-41d4-a716-446655440000'

-- This returns:
-- {
--   "deviceTypeId": 1,        -- Filter devices by type MPFM
--   "numberOfSeries": 1,      -- Single series (just OFR)
--   "seriesConfig": [{
--     "dataSourceProperty": "OFR",  -- Which JSON field to extract
--     "unit": "l/min"
--   }]
-- }
```

```sql
-- Step 3b: Query historical OFR data
SELECT
  dd.created_at as timestamp,
  dd.serial_number,
  COALESCE((dd.data->>'OFR')::numeric, 0) as value
FROM device_data dd
INNER JOIN device d ON dd.device_id = d.id
WHERE d.company_id = 1                    -- User's company
  AND d.device_type_id = 1                 -- MPFM devices only
  AND dd.created_at >= NOW() - INTERVAL '24 hours'  -- Last 24 hours
  AND dd.data ? 'OFR'                      -- Only records with OFR data
ORDER BY dd.created_at ASC
LIMIT 200
```

**Example response data:**
```json
{
  "success": true,
  "data": {
    "OFR": {
      "data": [
        {
          "timestamp": "2025-11-04T10:00:00Z",
          "serialNumber": "MPFM-ARB-101",
          "value": 850.5
        },
        {
          "timestamp": "2025-11-04T11:00:00Z",
          "serialNumber": "MPFM-ARB-101",
          "value": 870.2
        },
        {
          "timestamp": "2025-11-04T12:00:00Z",
          "serialNumber": "MPFM-ARB-102",
          "value": 920.1
        }
      ],
      "unit": "l/min",
      "propertyName": "Oil Flow Rate"
    }
  },
  "context": {
    "hierarchyId": null,
    "deviceId": null,
    "timeRange": "24h"
  }
}
```

### Step 4: Frontend Transforms Data for Chart

The React component (CustomLineChart) receives the data and transforms it for visualization:

```javascript
// Data from backend
const apiResponse = {
  data: {
    OFR: {
      data: [
        { timestamp: "2025-11-04T10:00:00Z", serialNumber: "MPFM-ARB-101", value: 850.5 },
        { timestamp: "2025-11-04T11:00:00Z", serialNumber: "MPFM-ARB-101", value: 870.2 },
        { timestamp: "2025-11-04T12:00:00Z", serialNumber: "MPFM-ARB-102", value: 920.1 }
      ],
      unit: "l/min"
    }
  }
};

// Transform for chart rendering
const chartData = {
  series: [
    {
      name: "OFR (Oil Flow Rate)",
      unit: "l/min",
      data: [
        { x: new Date("2025-11-04T10:00:00Z"), y: 850.5 },
        { x: new Date("2025-11-04T11:00:00Z"), y: 870.2 },
        { x: new Date("2025-11-04T12:00:00Z"), y: 920.1 }
      ]
    }
  ]
};

// Chart renders with X-axis (timestamps) and Y-axis (OFR values in l/min)
```

### Step 5: User Interacts with Chart (Optional)

The user can filter data by time range or hierarchy:

```http
-- Filter by specific well/hierarchy
GET /api/widgets/widget-data/550e8400-e29b-41d4-a716-446655440000?timeRange=24h&hierarchyId=1

-- Backend uses recursive CTE to find all devices under hierarchy
WITH RECURSIVE hierarchy_tree AS (
  SELECT id FROM hierarchy WHERE id = 1
  UNION ALL
  SELECT h.id FROM hierarchy h
  JOIN hierarchy_tree ht ON h.parent_id = ht.id
)
SELECT ... WHERE d.hierarchy_id IN (SELECT id FROM hierarchy_tree)
```

### Complete Data Flow Visualization

```
┌──────────────────────────────────────────────────────────────────────┐
│ USER BROWSER                                                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. User Logs In                                                    │
│     POST /api/auth/login                                            │
│     ↓ Receives JWT Token                                            │
│                                                                      │
│  2. Dashboard Loads                                                 │
│     GET /api/widgets/user-dashboard                                 │
│     ↓ Receives Dashboard + Widget Configs                           │
│                                                                      │
│  3. OFR Chart Component Requests Data                               │
│     GET /api/widgets/widget-data/{widgetId}?timeRange=24h           │
│     ↓ Receives Time-Series Data Points                              │
│                                                                      │
│  4. Component Renders Line Chart                                    │
│     Displays OFR values over time                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ API Calls
┌──────────────────────────────────────────────────────────────────────┐
│ BACKEND (Node.js/Express)                                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Auth Service                                                    │
│     → Validates credentials                                         │
│     → Generates JWT with company_id                                 │
│                                                                      │
│  2. Widget Service                                                  │
│     → Fetches dashboard config                                      │
│     → Returns widget definitions                                    │
│                                                                      │
│  3. Data Loading Service                                            │
│     → Extracts widget config (deviceTypeId, seriesConfig)           │
│     → Builds SQL query with filters                                 │
│     → Queries device_data table                                     │
│     → Transforms data to API format                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ SQL Queries
┌──────────────────────────────────────────────────────────────────────┐
│ DATABASE (PostgreSQL)                                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Tables:                                                            │
│  ├─ widget_definitions: Stores OFR chart configuration              │
│  ├─ device_data: Historical OFR readings                            │
│  ├─ device: Device metadata and company/type associations           │
│  └─ dashboards: Dashboard configurations                            │
│                                                                      │
│  Query optimizations:                                               │
│  ├─ Index on device.company_id for company filtering                │
│  ├─ Index on device_data.created_at for time filtering              │
│  ├─ GIN index on device_data.data for JSONB property access         │
│  └─ Index on device.device_type_id for device type filtering        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Performance Characteristics

1. **Dashboard Load**: ~200ms (2-3 SQL queries)
2. **Widget Data Load**: ~500ms (1 complex query with 200-point limit)
3. **Total Page Load**: ~1-2 seconds
4. **Data Updates**: Frontend can poll every 5-10 seconds

### Security Implementation

1. **Authentication**: JWT token required for all requests
2. **Company Isolation**: `WHERE d.company_id = req.user.company_id`
3. **Role-Based Access**: Only admins can create/modify widgets
4. **Row-Level Security**: Each query filters by company and user permissions

### Practical Testing with Postman

You can demonstrate this complete flow step-by-step:

1. **Run:** Admin Login → captures JWT
2. **Run:** Get User Dashboard → finds OFR widget ID
3. **Run:** Load OFR Chart Data (24h) → shows 200 latest data points
4. **Run:** Load OFR Chart Data (1h) → shows more granular data
5. **Run:** Load OFR Latest Data → shows current values from all devices
6. **Run:** Create Custom Widget → create new widget
7. **Run:** Add Widget to Dashboard → add to dashboard
8. **Run:** Update Layout → move widget around
9. **Run:** Remove Widget → clean up

This demonstrates the complete lifecycle of widget management and data loading to your supervisor.

---

## Summary

### Key Points

1. **Authentication Required:** All widget endpoints require valid JWT token
2. **Role-Based Access:** Admin operations (create, delete, update) restricted to admin users
3. **Company Isolation:** Users only see their company's dashboard and data
4. **Performance Optimized:** Uses `device_latest` for real-time data, `device_data` for historical
5. **Flexible Filtering:** Supports hierarchy and device-level filtering
6. **Time Range Support:** Multiple time ranges from 1 hour to 30 days

### Data Flow Summary

```
User Login → Get Dashboard → Load Widgets → For Each Widget:
  → Get Widget Config → Build Query → Filter by Company/Hierarchy/Device
  → Apply Time Range → Query device_data/device_latest
  → Transform Data → Return to Frontend → Render Component
```

### Testing Checklist

- [ ] Admin can login and access dashboard
- [ ] Regular user can login and access dashboard
- [ ] Widget data loads for all time ranges (1h, 6h, 24h, 7d, 30d)
- [ ] Hierarchy filtering works correctly
- [ ] Device filtering works correctly
- [ ] Latest data endpoint returns current values
- [ ] Admin can create custom widgets
- [ ] Admin can add widgets to dashboard
- [ ] Admin can remove widgets from dashboard
- [ ] Admin can update widget layout
- [ ] Regular users cannot access admin endpoints
- [ ] Invalid widget IDs return 404
- [ ] Missing parameters return 400

---

## Database Schema Reference

### Tables Used

```sql
-- Widget Types Catalog
widget_types (
  id UUID PRIMARY KEY,
  name VARCHAR(100),
  component_name VARCHAR(100),
  default_config JSONB
)

-- Widget Definitions (Custom Widgets)
widget_definitions (
  id UUID PRIMARY KEY,
  name VARCHAR(200),
  widget_type_id UUID REFERENCES widget_types(id),
  data_source_config JSONB,
  created_by BIGINT REFERENCES user(id)
)

-- Dashboards
dashboards (
  id UUID PRIMARY KEY,
  name VARCHAR(200),
  created_by BIGINT REFERENCES user(id),
  is_active BOOLEAN
)

-- Dashboard Layout
dashboard_layouts (
  id UUID PRIMARY KEY,
  dashboard_id UUID REFERENCES dashboards(id),
  widget_definition_id UUID REFERENCES widget_definitions(id),
  layout_config JSONB,
  display_order INTEGER
)

-- Device Data (Historical)
device_data (
  id BIGSERIAL PRIMARY KEY,
  device_id BIGINT REFERENCES device(id),
  serial_number TEXT,
  created_at TIMESTAMPTZ,
  data JSONB
)

-- Device Latest (Real-time)
device_latest (
  device_id BIGINT PRIMARY KEY REFERENCES device(id),
  serial_number TEXT,
  updated_at TIMESTAMPTZ,
  data JSONB
)
```

---

**Document Version:** 1.0
**Last Updated:** 2025-11-03
**Author:** Backend Development Team
