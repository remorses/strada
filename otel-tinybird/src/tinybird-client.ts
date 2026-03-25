// POST NDJSON to the Tinybird Events API.
// Uses the same endpoint and auth as the Go exporter: POST /v0/events?name={datasource}

export async function sendToTinybird(
  endpoint: string,
  token: string,
  datasource: string,
  ndjson: string,
): Promise<void> {
  const url = `${endpoint}/v0/events?name=${datasource}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      Authorization: `Bearer ${token}`,
    },
    body: ndjson,
  })

  if (!response.ok) {
    const body = await response.text()
    console.error(
      `Tinybird error for datasource "${datasource}": ${response.status} ${body}`,
    )
  }
}
