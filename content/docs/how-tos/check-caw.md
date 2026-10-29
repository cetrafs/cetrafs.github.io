---
weight: 320
title: "Check a LUN for atomic CAW"
description: "Probe whether a block device supports SCSI COMPARE AND WRITE, without mounting it, to find out if it can back a multi-node cluster."
toc: true
---

cetrafs coordinates cluster nodes only through atomic **SCSI COMPARE AND WRITE** (opcode `0x89`, also known as ATS). A device without it can still hold a cetrafs volume, but only one host can mount it at a time. Check a LUN before you plan a cluster around it.

## Run the probe

The probe opens the device read-only, reports what it can do, and mounts nothing:

```sh
sudo modprobe cetrafs caw_probe=/dev/sdb
sudo dmesg | grep 'caw probe'
sudo rmmod cetrafs
```

If the module is already loaded because a volume is mounted, you can't reload it with a probe. Read the same information from the mounted volume instead:

```sh
grep caw /proc/fs/cetrafs/*/properties
```

## Read the result

```text
cetrafs: caw probe: /dev/sdb -> class=scsi logical_block_size=512 max_caw_blocks=1 (atomic CAW available)
```

| Result | Meaning |
|---|---|
| `class=scsi`, `max_caw_blocks` ≥ 1 | The LUN supports atomic compare-and-write. It can back a multi-node cluster. One logical block is enough, whether it is 512 bytes or 4 KiB. |
| `logical_block_size=4096` | A 4Kn target, for example TrueNAS with a 4 KiB iSCSI extent. Supported since 0.9.1; with an earlier release, `fsync` and `close` on it fail with `EINVAL`. |
| `max_caw_blocks=0` | No atomic CAW. **Single-node only.** If one host has the volume mounted, a mount on any other host fails with `EBUSY`. |
| `class=nvme` | NVMe's fused compare-and-write cannot be called from a kernel module, so cetrafs treats the device as having no CAW. **Single-node only.** |
| `discover(...) failed` | cetrafs couldn't determine the capability. A mount on this device is **refused** rather than assuming either answer. |

## Check every node

Run the probe on **each** host that will mount the volume. The capability belongs to the path between the host and the array, and a virtualisation layer can hide it. For example, a LUN passed through VMware ESXi to Proxmox VMs only shows CAW if ESXi passes ATS through. If one node reports `0` and the others report `1`, fix the presentation before you go any further.

## Related

- [Cluster coordination](/docs/concepts/coordination/) explains why one primitive is enough.
- [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/) also covers cross-host coherency checks.
