// Extract project_id from the request hostname.
// The project ID is the ULID from the database project table.
// Hostname format: {projectId}-ingest.{domain}
// Example: 01JTHG5M7XPQR8KNCZ0W4D-ingest.strada.sh → "01JTHG5M7XPQR8KNCZ0W4D"
// No match: ingest.strada.sh, localhost → "" (empty string)

export function getProjectId(request: { url: string }): string {
  const hostname = new URL(request.url).hostname;
  const match = hostname.match(/^(.+)-ingest\./);
  if (match) return (match[1] ?? "").toUpperCase();
  return "";
}
