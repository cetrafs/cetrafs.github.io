---
weight: 330
title: "Create a volume"
description: "Format a block device with mkfs.cetra, preview the geometry first, and choose node, inode and journal capacity."
toc: true
---

{{< callout type="danger" >}}
`mkfs.cetra` destroys whatever is on the device. The volume must be **unmounted on every node** first.
{{< /callout >}}

## 1. Preview the geometry

The device always comes **first**, before any options:

```sh
sudo mkfs.cetra /dev/sdb -n
```

`-n` computes and prints the layout without writing anything: Zone Groups, Block Groups and their size, the inode table, the Node Registry capacity, the journal area and the location of each region.

## 2. Decide whether to change any defaults

For a large LUN the defaults are right. Change one only for a reason:

| You want | Flag | Default |
|---|---|---|
| Fewer nodes than 64, to save a little space | `-M <nodes>` | 64 (also the maximum) |
| More or fewer files | `-N <inodes>` | 1 per 4 MiB of device, capped at 65,536 |
| More Zone Groups, so more nodes can write at once | `-z <count>` | 16 (max 255; clamped to the number of Block Groups) |
| A different Block Group size | `-b <MiB>` | 1024 (min 512; shrinks to 512 automatically on small devices) |
| A different per-node journal size | `-J <MiB>` | 2 (shrinks automatically so all journals total about 5% of the device; `0` disables journaling) |

{{< callout type="note" title="Zone Groups limit concurrent writers" >}}
A Zone Group has one owner at a time, and only its owner allocates from it. **At most `-z` nodes can hold write capacity at the same time.** If more nodes than that mount, the extra ones mount fine but show `write_ready: no` until a Zone Group frees up. Make `-z` at least the number of nodes that will write.
{{< /callout >}}

The inode count is fixed at format time. Each inode takes a 4 KiB block on disk, which is why the default is modest: a VM datastore holds a few hundred large files, not millions of small ones.

## 3. Format

```sh
sudo mkfs.cetra /dev/sdb               # with defaults
sudo mkfs.cetra /dev/sdb -M 8 -z 32    # example: 8-node cluster, 32 Zone Groups
echo $?
```

## 4. Handle the exit code

| Code | Meaning | What to do |
|---|---|---|
| `0` | Volume created | Mount it. |
| `1` | Could not create it: device too small, not empty, impossible geometry, or a write failed | Read the message. For a device that previously held data, add `-f`. |
| `2` | Bad invocation or out-of-range argument | Fix the command line. |
| `3` | Device inaccessible, or **mounted locally or by a live peer** | Unmount it everywhere. mkfs won't format a live cluster's volume even with `-f`. |

`-f` overrides only the "device looks non-empty" check. It never overrides a live peer.

## Related

- [mkfs.cetra reference](/docs/reference/mkfs/)
- [Zone Groups and allocation](/docs/concepts/allocation/)
