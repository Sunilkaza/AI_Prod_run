# AgentOps Command Center — Manual ServiceNow Demo

This build preserves private GCS ingestion using ADC, and provides a **manual simulated ServiceNow incident notification**. No ServiceNow API request is sent when you click Simulate failure.

## Run

1. Extract ZIP.
2. In project folder run `npm install` and `npm run dev`.
3. Open http://localhost:5173.
4. Select Private GCS (ADC) and Load ingestion data (or bundled sample files).
5. Enter the **existing** ServiceNow incident number you plan to show (default `INC0010002`).
6. Click **Simulate failure → ServiceNow** at any active pipeline stage.
7. The UI shows a green demo notification and link to the ServiceNow incident list filtered to that number.
8. Open the link and show the already-created record in ServiceNow.

**This is a visual simulation only.** It does not create or verify tickets, and it does not claim an API call succeeded. Other KPIs are illustrative.

## GCS

Use `gcloud auth application-default login` in Windows CMD if ADC is not yet configured. Backend GCS environment variables are in `.env.example`. Keep secrets out of the frontend.
