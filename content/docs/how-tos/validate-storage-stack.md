---
weight: 385
title: "Validate a storage stack before deployment"
description: "Prove each layer, from the raw LUN up to live-migrating VMs, before the next, so a fault can always be traced to the layer that caused it."
toc: true
---

When a guest filesystem gets corrupted, the cause could be the array, the fabric, a hypervisor presenting the LUN, cetrafs, qemu or the guest. The way to keep that answerable is to **prove each layer clean before testing the one above it**. A mature layer that corrupts data on its own is not a cetrafs bug.

| Layer | What | Trust |
|---|---|---|
| L0 | SAN array, fabric, HBA | Mature |
| L1 | How the LUN is presented to the hosts (direct, RDM, passthrough) | Mature code; **the configuration is the risk** |
| L2 | cetrafs, single node | Under test |
| L3 | cetrafs, whole cluster | Under test |
| L4 | Proxmox/qemu with VM images on cetrafs | Mature |
| L5 | Guest OS and application | |

Keep independent backups until the top layer has soaked clean.

## L0: the raw LUN

Present the LUN to one host and test the block device directly, with no cetrafs.

```sh
fio --name=v --filename=/dev/sdX --rw=randrw --bs=4k --iodepth=32 --size=20G \
    --verify=crc32c --verify_fatal=1 --runtime=2h --time_based
```

Then test power-loss durability: run a `diskchecker.pl`-style client writing with `fsync`, cut power, reboot, verify.

**Pass:** zero verify errors and zero loss of `fsync`ed data. If this fails, stop. The array cache doesn't honour flushes, and nothing built on top of it can be sound.

## L1: shared presentation

On **each** host, against the device cetrafs will use:

1. **Atomic CAW reaches the host.** [Probe it](/docs/how-tos/check-caw/) and require `max_caw_blocks >= 1` everywhere. If it reads `0`, a hypervisor in the path isn't passing SCSI ATS through.
2. **Hosts see each other's writes.** Nothing between the hosts and the array may cache the device per host:

   ```sh
   # host A
   dd if=/dev/urandom of=/dev/sdX bs=512 count=1 seek=1000000 oflag=direct
   dd if=/dev/sdX bs=512 count=1 skip=1000000 iflag=direct | md5sum
   # host B
   blockdev --flushbufs /dev/sdX
   dd if=/dev/sdX bs=512 count=1 skip=1000000 iflag=direct | md5sum   # must match A
   ```

3. **Flushes are honoured.** No write cache in the path may absorb them.

**Pass:** CAW on every host, and reads that agree across hosts. These are the only L1 properties cetrafs depends on. Verify them; don't assume them.

## L2: cetrafs on one node

Mount on one host only.

- `fio --verify=crc32c --fsync=16 --runtime=6h` on a file on cetrafs.
- `fsstress` inside a guest filesystem image stored on cetrafs.
- Power loss: run a `diskchecker.pl`-style client against a cetrafs file, then `echo b > /proc/sysrq-trigger`, remount, `fsck.cetra -r`, verify.
- After every run: `fsck.cetra <dev>` must be clean.

**Pass:** no verify errors, no loss of `fsync`ed data, fsck clean (after `-r` following a crash; residue from operations that weren't acknowledged is expected).

## L3: the cluster

Mount on every node.

- Run `fio --verify=crc32c` on all nodes at once, each on its own files.
- Power off one node in the middle of a write. The survivors must stay clean, the dead row must be reclaimed, and `fsck.cetra -r` must come back clean.
- Fill the volume to about 100% and keep writing. You should get a clean `ENOSPC` and no corruption.
- On every node, watch `dmesg | grep -i cetrafs` (any `EUCLEAN`, `leaking`, `WARNING` or `BUG` is a finding) and `/proc/fs/cetrafs/<dev>/info`: `cas_miscompares` must rise under contention, and `free_data_blocks` must not drift.

The multi-node test suite (`ctest/`) belongs at this layer. See [Run the test suites](/docs/how-tos/run-tests/).

## L4: VMs on cetrafs

`cache=none` disks on a `nofilelock` mount.

- Run `fio --verify=crc32c --fsync=16` inside a guest.
- Live-migrate the VM **while** guest fio runs. The migration must complete with zero verify errors.
- Snapshot, migrate, delete the snapshot, all under load. The VM must boot, its data must be intact, and fsck must be clean.
- Migrate back and forth 50 times under load.

## L5: full stack with HA

Run everything above at once, as a soak lasting several weeks, with Proxmox HA fencing enabled.

- Kill a node that is running VMs. HA must restart them on survivors, and their images must be intact.
- Cut a node off the network. HA must fence it, and it must not keep writing.

## Bisecting a symptom

| Symptom | Reproduce at | Clean there → | Dirty there → |
|---|---|---|---|
| Guest filesystem corruption | L2 | Look at L3, L4, or L1 coherency | cetrafs single-node, or L0/L1 |
| Data lost after a power cut | L0, then L2 | L0 clean and L2 lost: cetrafs flush handling | L0 lost: the array cache isn't durable |
| Corruption only after migration or concurrent use | L1 coherency and CAW checks | Both fine: cetrafs at L3 | Hypervisor caching or no ATS, below cetrafs |
| Two nodes writing at once (split-brain) | L1 CAW, HA fencing | CAW fine, no fencing: fix the HA configuration | `max_caw_blocks=0`: ATS not passed through |
| Leaked space in fsck | L3 | | Check `scrub_reclaimed` is rising; otherwise report it |
| Slow metadata operations | Expected | Each metadata operation costs real device round trips. Not a bug. | |
