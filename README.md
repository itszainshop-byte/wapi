# whapi

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-541vwmll)

## Deploy to Google Cloud Run

This repository includes a Docker image that builds the Vite frontend and serves it from the Node/WhatsApp backend. The container listens on the `PORT` supplied by Cloud Run.

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud builds submit \
	--config cloudbuild.yaml \
	--project YOUR_PROJECT_ID \
	--substitutions=_IMAGE=REGION-docker.pkg.dev/YOUR_PROJECT_ID/whapi/whapi,_VITE_BACKEND_URL=https://zain01-534219343809.europe-west1.run.app
gcloud run deploy whapi \
	--image REGION-docker.pkg.dev/YOUR_PROJECT_ID/whapi/whapi \
	--region REGION \
	--platform managed \
	--allow-unauthenticated \
	--memory 2Gi \
	--cpu 1 \
	--timeout 3600 \
	--min 1 \
	--max 1
```

Replace `YOUR_PROJECT_ID` and `REGION`, and enable Cloud Build, Artifact Registry, and Cloud Run APIs in the project first. `--allow-unauthenticated` is required if the browser frontend should call the service directly.

The frontend currently defaults to `https://zain01-534219343809.europe-west1.run.app` as its backend. To point the image at a different service URL, pass a different `_VITE_BACKEND_URL` substitution at build time, including the `/api` path or the base origin:

```bash
gcloud builds submit \
	--config cloudbuild.yaml \
	--project YOUR_PROJECT_ID \
	--substitutions=_IMAGE=REGION-docker.pkg.dev/YOUR_PROJECT_ID/whapi/whapi,_VITE_BACKEND_URL=https://YOUR_SERVICE_URL
```

WhatsApp sessions and the local `backend/users.json` file use the container filesystem. Cloud Run storage is ephemeral, so configure a persistent storage solution and set `SESSION_ROOT` before production use, or expect sessions and locally stored users to be lost when the instance is replaced. Supabase remains the database used by the frontend.

The service health endpoint is `GET /healthz`.
