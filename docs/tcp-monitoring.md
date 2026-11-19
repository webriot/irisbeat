# TCP Monitors

A TCP Monitor succeeds when it opens a plain connection to a host and port.
Use HTTP(S) if you need to check the service's HTTP response.

## Configure a Monitor

1. In `/operator`, select **New Monitor** and choose **TCP** as the check type.
2. Enter a DNS name, IPv4 address, or IPv6 literal, and a port from 1 to 65,535.
   The target must be reachable from Cloudflare Workers and meet its
   [TCP socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
3. Choose an [interval](monitor-api.md#http-and-tcp-checks) or
   [calendar schedule](monitor-api.md#http-and-tcp-calendar-schedules), then save.

A refusal, network error, or timeout counts as a failure. Each attempt keeps its
starting target and timeout. Target edits apply to later attempts, preserving
the Monitor ID, history, and Incidents. Connection cleanup runs independently
of the result and future checks.

## API

To create this private Monitor, send the example body to `POST /api/operator/monitors`.

```json
{
  "name": "Database",
  "kind": "tcp",
  "hostname": "db.example.com",
  "port": 5432,
  "published": false
}
```

Edit it with `PATCH /api/operator/monitors/:id`. You can change the hostname
or port independently. The API rejects kind changes and leaves saved
configuration intact when validation fails. Public responses omit the hostname
and port. See the [Monitor API](monitor-api.md) for authorization, response
fields, timing settings, and upgrade behavior.
