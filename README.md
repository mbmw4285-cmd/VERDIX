# VERDIX — GitHub-ready update

This package includes **both manual and IR-triggered scanning**. The manual **Capture & Classify** button remains available. When **IR Automatic Scan** is enabled in the dashboard, it polls the backend for an event sent by the ESP32 IR sensor and captures/classifies the webcam image. The user still confirms the category with **Confirm & Sort** before a physical sort request is sent.

## Files
- `public/index.html`, `public/style.css`, `public/app.js`: dashboard and camera workflow.
- `public/config.js`: backend URL used by the hosted frontend.
- `server.js`: Gemini classification, sort endpoint, and IR event endpoints.
- `esp32_ir_trigger_example.ino`: sample ESP32 sketch to send IR events to the backend.

## GitHub upload
Copy the contents of this folder into your existing `VERDIX` repository folder, keeping the `public` folder structure. Commit and push to `main`.

## Backend environment variables
- `GEMINI_API_KEY`: required; set only in Render/backend environment settings, never in GitHub.
- `GEMINI_MODEL`: optional, defaults to `gemini-2.5-flash`.
- `ESP32_URL`: optional base URL for your ESP32 sorting controller. It must accept `POST /sort` with `{ "material": "PLASTIC" }` etc.
- `IR_TRIGGER_TOKEN`: recommended shared secret for IR event requests. Use a long random value.
- `FRONTEND_URL`: optional Netlify origin, if restricting CORS.

## Configure the ESP32 IR trigger
1. Open `esp32_ir_trigger_example.ino` in Arduino IDE.
2. Enter your Wi-Fi name/password, backend URL, and shared token.
3. In Render, set `IR_TRIGGER_TOKEN` to exactly the same value as the sketch, then redeploy the backend.
4. Check your actual sensor wiring and active state. Example uses IR OUT on GPIO 13 and active-LOW output; change these if needed.
5. Upload the sketch to your ESP32 DevKit.
6. Open the dashboard over HTTPS, allow webcam access, start the camera, and enable **IR Automatic Scan**.
7. Place one item in front of the IR sensor. The dashboard should capture and classify it. Confirm the result before pressing **Confirm & Sort**.

## Important behavior
- Manual scanning works without the IR sensor.
- Automatic scanning requires the ESP32 sketch to send `/api/ir-trigger` events to the same backend the dashboard uses.
- The camera is the computer/USB webcam in this version; it is not streaming video directly from ESP32-CAM.
- AI classification needs `GEMINI_API_KEY`. Physical servo control needs a reachable, correctly implemented ESP32 sorting endpoint. Without that, the sort endpoint returns simulation mode.
- Test with the servo power disconnected first, and verify the category before allowing physical movement.
