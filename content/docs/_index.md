---
weight: 1
title: "Documentation"
description: "Documentation for cetrafs, the Linux shared-disk cluster filesystem: tutorials, how-to guides, design concepts, and reference for the tools and on-disk format."
toc: false
---

The documentation is split into four kinds, according to what you need at the moment.

<div class="quadrants" style="margin-top:26px">
  <a class="quadrant q-tutorials" href="/docs/tutorials/">
    <span class="q-kind">Tutorials</span>
    <h3>I want to learn</h3>
    <p>Guided, hands-on lessons that end with something working. Start with a single-node volume on a loop device; it needs no special hardware.</p>
  </a>
  <a class="quadrant q-how-tos" href="/docs/how-tos/">
    <span class="q-kind">How-to guides</span>
    <h3>I have a task</h3>
    <p>Step-by-step recipes for installing, configuring, monitoring, repairing and recovering a cetrafs deployment.</p>
  </a>
  <a class="quadrant q-concepts" href="/docs/concepts/">
    <span class="q-kind">Concepts</span>
    <h3>I want to understand</h3>
    <p>How cetrafs coordinates nodes through the storage, why it locks whole files, what fencing does and doesn't cover, and how it compares to VMFS and GFS2.</p>
  </a>
  <a class="quadrant q-reference" href="/docs/reference/">
    <span class="q-kind">Reference</span>
    <h3>I need a fact</h3>
    <p>Tool flags and exit codes, mount options, every procfs field and module parameter, hard limits, and the on-disk format.</p>
  </a>
</div>

## Where to start

- **Evaluating cetrafs?** Read [What is cetrafs?](/docs/intro/), then [Project status](/docs/intro/status/) and [Limits and unsupported operations](/docs/reference/limits/). Those three pages will tell you whether it fits your workload.
- **Want to try it?** Follow [Your first cetrafs volume](/docs/tutorials/first-volume/). It runs on any supported Linux host using a loop device.
- **Deploying on Proxmox VE?** Work through [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/), then the [VM disk settings](/docs/how-tos/configure-vm-disks/) guide.
- **Something went wrong?** See [Troubleshooting](/docs/reference/troubleshooting/) and [Recover from a node failure](/docs/how-tos/recover-node-failure/).
