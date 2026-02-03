// Runtime configuration
// This file is loaded before the app starts and can be modified without rebuilding
// Leave BACKEND_URL empty for local development (will fallback to localhost:3000)
// In production, this gets replaced via ConfigMap/deployment
window.__APP_CONFIG__ = {
  BACKEND_URL: 'BACKEND_URL_PLACEHOLDER'
};
