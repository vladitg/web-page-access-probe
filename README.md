# Public page access probe

A manually triggered, read-only integration check for publicly accessible deal pages. No application code, website credentials, affiliate credentials or publishing integration is included.

The workflow uses a standard GitHub-hosted Ubuntu VM and its ordinary Chrome browser. It compares direct HTTP requests with rendered pages in two rounds. It records numeric temperature and explicit expiration flags from page state only when the returned record ID matches the requested ID. HTTP errors, challenge pages, missing fields and ID mismatches fail the check.

There are no scheduled jobs, proxies, CAPTCHA solvers, browser fingerprint changes, or writes to a deal website. Targets are supplied manually as workflow inputs; results are written to the workflow log and job summary. No Actions artifacts or caches are uploaded.

Standard GitHub-hosted runners in public repositories are free: https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories
