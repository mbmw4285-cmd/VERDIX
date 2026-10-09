# VERDIX Starter Dashboard

Starter website for VERDIX – AI-Based Smart Waste Sorting and Management System.

## Included
- Responsive dashboard for Plastic, Metal, Organic and Other
- Express API health and status endpoints
- Demo classification buttons and recent activity
- Endpoints for future classification and bin-fill readings

## Not connected yet
This is a starter demo, not the complete hardware/AI system. Gemini, webcam, ESP32, servos, ultrasonic sensors and database are not connected. Data is held in memory and resets when the server restarts. Demo buttons do not move hardware.

## Deploy
Build command: `npm install`
Start command: `npm start`

## API endpoints
- `GET /api/health`
- `GET /api/status`
- `POST /api/classification` with JSON `{"category":"Plastic","confidence":95}`
- `POST /api/bins` with JSON `{"bin":"Plastic","fill":40}`

## Secret safety
Never put a real Gemini API key in `public/index.html` or commit it to GitHub. Use your host's environment settings, or a local `.env` file excluded by `.gitignore`.
