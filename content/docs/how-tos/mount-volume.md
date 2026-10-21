---
weight: 335
title: "Mount a volume at boot"
description: "Mount cetrafs read-write or as a read-only observer, by hand, from /etc/fstab, or with a systemd mount unit."
toc: true
---

## Mount by hand

Read-write, as a full cluster participant:

```sh
sudo mount -t cetrafs /dev/sdb /mnt/cetra
```

As a read-only **observer**, to inspect a live volume from another host without taking write capacity or replaying anything:

```sh
sudo mount -t cetrafs -o ro /dev/sdb /mnt/cetra
```

For a Proxmox/qemu cluster that live-migrates VMs, add `nofilelock`. See [Enable live migration](/docs/how-tos/live-migration/).

## Mount at boot with `/etc/fstab`

```fstab
/dev/mapper/mpatha  /mnt/cetra  cetrafs  _netdev,nofail  0  0
```

- `_netdev` waits for the network, which iSCSI needs. It does no harm on Fibre Channel.
- `nofail` lets the host finish booting if the LUN isn't there.
- Add `nofilelock` to the options on a live-migration cluster, and add it on **every** node.
- Use a stable device name: a multipath alias, or a `/dev/disk/by-id/...` path. Never a bare `/dev/sdX`, which can change between boots.

You don't need to load the module in advance. The first cetrafs mount loads it.

## Mount with a systemd unit

If you prefer a unit, name it after the mount path (`/mnt/cetra` becomes `mnt-cetra.mount`):

```ini
# /etc/systemd/system/mnt-cetra.mount
[Unit]
Description=cetrafs shared datastore
After=network-online.target iscsid.service multipathd.service
Wants=network-online.target

[Mount]
What=/dev/mapper/mpatha
Where=/mnt/cetra
Type=cetrafs
Options=nofilelock

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mnt-cetra.mount
```

## Check the mount

```sh
ls /proc/fs/cetrafs/                         # one directory per mounted volume
grep -E 'write_ready|file_lock|fenced' /proc/fs/cetrafs/*/info
```

## Changing mode later

Read-only and read-write participation, and the file-lock mode, are fixed at mount time. `mount -o remount,ro` and remounts that change `nofilelock` are refused. Unmount and mount again with the options you want.

## If the mount fails

| Error | Meaning |
|---|---|
| `EBUSY` | The device has no atomic CAW and another node already has it mounted. Mount it on one node only. |
| `EINVAL` with a version or feature message in `dmesg` | The volume was made by a different format version. Reformat it; there is no migration. |
| `EINVAL` with a file-lock mode message in `dmesg` | You asked for a file-lock mode that conflicts with the one the cluster already uses. Use the same options as the other nodes. |

The [troubleshooting reference](/docs/reference/troubleshooting/) has more.
