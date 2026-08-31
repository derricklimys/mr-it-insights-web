// Fill in CLIENT_ID after creating the "Web application" OAuth client in
// Google Cloud Console (same project as the migration scripts) - see
// SETUP.md. This value is public by design for browser OAuth apps; it is
// not a secret.
const CONFIG = {
  CLIENT_ID: "985263849983-h29lfi11tpadjml0l5f5slba5bh4go72.apps.googleusercontent.com",
  SCOPES: [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly",
  ].join(" "),
  ROOT_FOLDER: "Mr IT Insights",
  INVOICES_FOLDER: "Invoices",
  ARONIUM_FOLDER: "AroniumReports",
  ARONIUM_DB_FILE: "pos-latest.db",
};
