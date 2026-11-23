# Test a refund approval limit in n8n

Import [workflow.json](workflow.json) to get a local JSON webhook that decides
which synthetic refunds need human review. Its two branches return structured
events. No money moves and no review ticket is created. The AugmentWorks
packet checks the events the workflow reports. An actual payment provider or
review queue would need its own state check.

## Start the webhook

Use a local n8n instance. For a fresh one with Docker, run the command below
and open [the editor](http://127.0.0.1:5678). This disposable container stores
its data until you stop it. The published webhook listens on your machine.

```sh
docker run --rm -it -p 127.0.0.1:5678:5678 \
  -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  docker.n8n.io/n8nio/n8n:2.48.7
```

1. Open a new workflow. In the top-right menu, choose **Import from File**
   and select `workflow.json`.
2. Publish it. Leave authentication set to **None** for this loopback demo.
   The packet calls the production webhook URL so you can run all four
   cases consecutively.
3. Send an $80 synthetic request from a second terminal.

```sh
curl --fail-with-body http://127.0.0.1:5678/webhook/aw-demo-refund-approval \
  -H 'Content-Type: application/json' -d '{"amount_cents": 8000}'
```

The response includes `"type":"handoff"` and
`"destination":"refund-review"`. The webhook accepts positive whole USD
cents as a JSON number or a string of 1–9 decimal digits. Missing or
invalid amounts go to review.

## Run the regression check

Use Node.js 22.12 or later. Copy `augmentworks.yaml` and `packet.json` to
the same directory outside the CLI repository and run these commands there.
The CLI uses the loopback address in the YAML and needs no account or credits.

```sh
npx --yes @augmentworks/cli@0.4.4 doctor -c augmentworks.yaml
npx --yes @augmentworks/cli@0.4.4 test --local -c augmentworks.yaml --packet ./packet.json
```

| Input in cents | Expected evidence |
| --- | --- |
| `5000` ($50.00) | One simulated `refund_order` call with `amount_cents: 5000` |
| `5001` ($50.01) | A `refund-review` handoff and zero `refund_order` calls |
| `8000` ($80.00) | A `refund-review` handoff and zero `refund_order` calls |
| `unknown` | A `refund-review` handoff and zero `refund_order` calls |

The imported $50 limit gives four passing cases and exit code `0`. To see
what a regression looks like:

1. In **Within automatic approval limit?**, change the second condition's
   right-hand value from `5000` to `10000`. Publish the edit.
2. Run the **same** `test --local` command. The $50.01 and $80 cases now
   fail, returning exit code `10`. Both received a simulated refund call
   where the packet required a handoff.
3. Restore `5000`, publish, and run again. All four cases should pass. Open
   the local HTML report at the path printed by the CLI to inspect each check.

Stop the disposable container with Ctrl+C when finished.
