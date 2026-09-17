# The hosted demonstration

Live at **https://pct-demo.calmisland-fe569d85.centralindia.azurecontainerapps.io**

Anyone with the link can open it. They meet an acknowledgement notice first,
and the application is behind it.

---

## What is deployed, and why it is not just the app

The application has **no authentication**. The user switcher is a header shim,
so on a public URL anyone could act as a named clinician and sign an advisory
carrying a registration number. Nothing stops a visitor typing real patient
details into a system with no Data Processing Agreement behind it.

Public mode, enabled by `PCT_PUBLIC_DEMO=1`, is the answer to that. It is not
security. It is a demonstration that states plainly what it is.

| | |
|---|---|
| **Database** | In-memory. Nothing is written to disk, and everything is discarded when the container restarts. |
| **Acknowledgement gate** | Nobody reaches the application, or any API route, without accepting a notice. Cookie-backed and signed, checked server-side, so it cannot be stepped around by calling the API directly. |
| **Crawlers** | `x-robots-tag: noindex, nofollow, noarchive` on every response, plus `X-Frame-Options: DENY`. |
| **Container** | Runs as a non-root user. No writable volume. |

The notice is versioned. Changing its wording invalidates every prior
acknowledgement, which is the point of versioning it.

### Everyone shares one database

There is a single in-memory database per running container. Visitors see each
other's cases, and the whole thing is wiped on restart. For a demonstration
that is fine and occasionally useful. It is also a reason not to put anything
in it you would mind a stranger reading.

---

## Where it runs

| | |
|---|---|
| Subscription | Azure subscription 2, deliberately not the one holding the vigiams production and beta resources |
| Resource group | `rg-pct-demo`, created for this and holding nothing else |
| Region | Central India |
| Service | Azure Container Apps |
| Registry | `ca9b39403856acr.azurecr.io`, created by the deploy |

**One replica is kept warm.** With scale-to-zero the first visitor after an
idle period waited minutes for a cold start, which fails the only requirement
that matters here: that the link works when someone opens it. That costs
something. See below.

The image is built by Azure from source. There is no local Docker, and no
Dockerfile build step, because Node runs the TypeScript directly.

---

## Redeploying

From the project root, after committing whatever changed:

```bash
az account set --subscription 64df5331-e3ac-4b6a-8e56-a9b31aa048fd

az containerapp up \
  --name pct-demo \
  --resource-group rg-pct-demo \
  --location centralindia \
  --environment pct-demo-env \
  --registry-server ca9b39403856acr.azurecr.io \
  --source . \
  --target-port 8080 \
  --ingress external
```

That builds a fresh image in Azure and rolls it out. It takes a few minutes,
most of which is the build.

**Restarting wipes the demonstration data**, because the database is in memory.
That is usually what you want before showing it to someone.

```bash
az containerapp revision restart -n pct-demo -g rg-pct-demo \
  --revision $(az containerapp revision list -n pct-demo -g rg-pct-demo \
               --query "[?properties.active].name | [0]" -o tsv)
```

Logs:

```bash
az containerapp logs show -n pct-demo -g rg-pct-demo --follow
```

---

## Cost, and turning it off

A warm replica at 0.5 vCPU and 1 GiB runs continuously. Azure Container Apps
includes a monthly free grant, and this sits above it, so expect a modest
monthly charge rather than nothing. Check the real number in Cost Management
rather than trusting an estimate here.

**To stop paying while keeping everything in place**, scale to zero. The link
still works; the first visitor after an idle period waits for a cold start.

```bash
az containerapp update -n pct-demo -g rg-pct-demo --min-replicas 0
```

**To delete the whole thing**, including the registry and the logs workspace:

```bash
az group delete -n rg-pct-demo --yes
```

Nothing outside `rg-pct-demo` is touched, and nothing of value is lost. The
database is in memory and the source lives in git.

---

## Running public mode locally

Useful for checking the notice before it faces anyone.

```bash
PCT_PUBLIC_DEMO=1 npm run serve
```

The database becomes in-memory and seeds itself at boot. The acknowledgement
cookie drops its `Secure` flag over plain HTTP so the gate is testable on
localhost; behind a TLS-terminating proxy the flag is set.

---

## What this deployment is still not

Everything in `docs/CORRECTIONS.md` section D remains true. In particular there
is no authentication, no SMART on FHIR resolution, no JWT validation on the CDS
Hooks endpoints, and no key management. Hosting it has not changed any of that;
it has only put a notice in front of it.

Do not point a real adverse drug reaction workflow at this URL.
