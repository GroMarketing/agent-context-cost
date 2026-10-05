---
name: deploy-helper
description: Deploy the current branch to the staging environment and report the URL.
disable-model-invocation: true
---

# deploy-helper

Run the staging deploy script, wait for the health check, and print the URL.
Stop and report if the health check fails twice.
