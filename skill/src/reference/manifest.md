# The service manifest: `{{MANIFEST_FILENAME}}`

One file per service, at the service root. YAML. Every key shown is required unless marked optional. Unknown keys are rejected.

```yaml
service: checkout # same as OTEL_SERVICE_NAME; lower-case, digits, - and _
description: Handles cart, payment and order confirmation
endpoints: # every endpoint the service handles
  - method: POST # GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS
    route: /checkout/pay # the route template, exactly as http.route reports it
    description: Charges the customer and creates the order # optional, recommended
  - method: GET
    route: /orders/{id}
    description: Returns one order
metrics: # every metric the service emits
  - name: http.server.request.duration
    type: histogram # histogram, counter or gauge
    unit: s # s, By, or an annotation such as "{order}"
    description: Duration of requests this service handles
  - name: http.client.request.duration # only if the service calls other services over HTTP
    type: histogram
    unit: s
    description: Duration of HTTP calls this service makes to others
  - name: orders.completed
    type: counter
    unit: '{order}' # quote annotations: braces mean something in YAML
    description: Orders paid successfully
    attributes: [payment.method] # optional; the attributes you set, as written in the code
  - name: orders.export.duration
    type: histogram
    unit: s
    description: Duration of the nightly order export job
    attributes: [job.name, job.result]
```

Notes:

- `route` must be the value the framework's instrumentation puts in `http.route`. Frameworks spell parameters differently: Express reports `/orders/:id`, FastAPI and most others `/orders/{id}`. Write what the instrumentation reports. Check it in the console exporter output rather than guessing.
- Do not list `attributes` for the two HTTP metrics; theirs are fixed by the convention.
- `type` is `histogram`, `counter` or `gauge`. Anything the framework emits that fits none of these (an up-down counter such as `http.server.active_requests`) is not part of the convention: switch it off rather than list it.
- Descriptions are read by people choosing a metric and by the assistant matching a request to a metric. Say what is measured in plain words: "Orders paid successfully", not "counter for orders".
- A metric's `name`, `type` and `unit` here must match what the code creates. If they differ, the metric is registered under a name that has no data.
