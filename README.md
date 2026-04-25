# Blood Donation Management System

A lightweight Blood Donation Management System built with pure Node.js, HTML, CSS, and vanilla JavaScript.

## What Was Upgraded

- Reliable JSON persistence for donors, requests, and donor notifications
- Safer backend validation and error handling
- Configurable donor search radius
- Blood compatibility plus distance-based donor matching
- Leaflet maps for donor and hospital dashboards
- Real-time polling every 5 seconds
- Donor availability toggle backed by the API
- Emergency request mode and request history tracking
- Optional Fast2SMS integration with automatic fallback to simulated notifications

## Backend Routes

- `GET /health`
- `GET /donors`
- `POST /add-donor`
- `POST /donors/update-status`
- `GET /donors/nearby?lat=&lon=&bloodGroup=&radius=&available=`
- `GET /requests`
- `POST /request-blood`
- `GET /notifications?donorId=`
- `POST /notifications/mark-read`
- `POST /send-sms`
- `GET /analytics?lat=&lon=&radius=`

## Files Added Or Updated

- `server.js`
- `utils/dataStore.js`
- `utils/matchService.js`
- `utils/smsService.js`
- `donor.html`
- `donor-dashboard.html`
- `hospital.html`
- `hospital-dashboard.html`
- `data/notifications.json`

## Run

```bash
npm start
```

Server default:

```text
http://localhost:3002
```

## Fast2SMS Setup

Create a `.env` file if you want real SMS:

```text
FAST2SMS_API_KEY=your_api_key_here
DEFAULT_RADIUS_KM=8
PORT=3002
```

Without `FAST2SMS_API_KEY`, the backend stays fully functional and uses simulated notification results.

## Presentation Highlights

- Hospitals can create emergency or normal requests with a configurable radius.
- Donors and hospitals both show live location maps using Leaflet.
- Nearby donors are sorted by availability and distance.
- Donors get request notifications in their dashboard with unread status.
- The system works without Express, which is a good point for explaining fundamentals.
