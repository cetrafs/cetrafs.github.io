---
weight: 200
title: "Tutorials"
description: "Hands-on lessons. Each one starts from nothing and ends with something working."
toc: false
---

Tutorials are for learning. Follow them in order, run every command, and look at what each step prints. They explain only as much as you need along the way; for the reasoning, see [Concepts](/docs/concepts/).

1. **[Your first cetrafs volume](/docs/tutorials/first-volume/)** builds the module and tools, creates a volume on a loop device, mounts it, looks inside, and checks it with `fsck`. You need one Linux host and no special storage.
2. **[A two-node cluster on a shared LUN](/docs/tutorials/two-node-cluster/)** mounts one LUN on two hosts and shows the cluster at work: node registration, Zone Group ownership, the cross-node file lock, and failover.
3. **[Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/)** puts VM disks on cetrafs across a Proxmox cluster and live-migrates a running VM.
