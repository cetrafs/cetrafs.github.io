---
weight: 405
title: "Architecture overview"
description: "The shape of cetrafs: independent nodes, one shared disk, no network between them, and an on-disk layout built for compare-and-write."
toc: true
---

## Shared disk, not shared nothing

In a cetrafs cluster every node runs its own kernel, with its own page cache and no shared memory, and every node is attached to the **same physical blocks**. No data is replicated between nodes. There is one copy, on the LUN, and protecting it is the array's job (RAID, snapshots, replication).

What the nodes have to agree on is *who may change what*. cetrafs settles that through the storage itself, never over the network.

<figure>
<svg class="diagram" viewBox="0 0 760 330" role="img" aria-label="Three nodes attached to one shared LUN; every claim is a compare-and-write on the LUN" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--font-sans);font-size:13px">
  <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker></defs>
  <g>
    <rect x="30" y="20" width="200" height="92" rx="12" fill="var(--surface)" stroke="var(--border)"/>
    <text x="130" y="46" text-anchor="middle" font-weight="700" fill="var(--text)">Node A</text>
    <text x="130" y="68" text-anchor="middle" fill="var(--muted)">VMs 101, 102</text>
    <text x="130" y="90" text-anchor="middle" fill="var(--muted)" font-family="var(--font-mono)" font-size="11.5">cetrafs.ko · own cache</text>
    <rect x="280" y="20" width="200" height="92" rx="12" fill="var(--surface)" stroke="var(--border)"/>
    <text x="380" y="46" text-anchor="middle" font-weight="700" fill="var(--text)">Node B</text>
    <text x="380" y="68" text-anchor="middle" fill="var(--muted)">VMs 201, 202</text>
    <text x="380" y="90" text-anchor="middle" fill="var(--muted)" font-family="var(--font-mono)" font-size="11.5">cetrafs.ko · own cache</text>
    <rect x="530" y="20" width="200" height="92" rx="12" fill="var(--surface)" stroke="var(--border)"/>
    <text x="630" y="46" text-anchor="middle" font-weight="700" fill="var(--text)">Node C</text>
    <text x="630" y="68" text-anchor="middle" fill="var(--muted)">VM 301</text>
    <text x="630" y="90" text-anchor="middle" fill="var(--muted)" font-family="var(--font-mono)" font-size="11.5">cetrafs.ko · own cache</text>
  </g>
  <line x1="130" y1="112" x2="130" y2="196" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ah)" marker-start="url(#ah)"/>
  <line x1="380" y1="112" x2="380" y2="196" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ah)" marker-start="url(#ah)"/>
  <line x1="630" y1="112" x2="630" y2="196" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ah)" marker-start="url(#ah)"/>
  <text x="142" y="150" fill="var(--muted)" font-size="12">reads, writes,</text>
  <text x="142" y="166" fill="var(--muted)" font-size="12">compare-and-write</text>
  <line x1="230" y1="66" x2="280" y2="66" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 4"/>
  <line x1="480" y1="66" x2="530" y2="66" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 4"/>
  <text x="380" y="136" text-anchor="middle" fill="var(--danger)" font-size="12">no network protocol between nodes</text>
  <rect x="30" y="200" width="700" height="112" rx="14" fill="var(--brand-tile)"/>
  <text x="380" y="228" text-anchor="middle" fill="#fff" font-weight="700" font-size="15">Shared LUN (iSCSI / Fibre Channel)</text>
  <g font-size="11.5" fill="#fff" font-family="var(--font-mono)">
    <rect x="48" y="244" width="120" height="50" rx="7" fill="rgba(255,255,255,.14)"/><text x="108" y="265" text-anchor="middle">Node Registry</text><text x="108" y="282" text-anchor="middle" opacity=".75">heartbeats</text>
    <rect x="180" y="244" width="120" height="50" rx="7" fill="rgba(255,255,255,.14)"/><text x="240" y="265" text-anchor="middle">Zone Groups</text><text x="240" y="282" text-anchor="middle" opacity=".75">ownership</text>
    <rect x="312" y="244" width="120" height="50" rx="7" fill="rgba(255,255,255,.14)"/><text x="372" y="265" text-anchor="middle">Inodes</text><text x="372" y="282" text-anchor="middle" opacity=".75">+ in-record locks</text>
    <rect x="444" y="244" width="120" height="50" rx="7" fill="rgba(255,255,255,.14)"/><text x="504" y="265" text-anchor="middle">Journals</text><text x="504" y="282" text-anchor="middle" opacity=".75">one per node</text>
    <rect x="576" y="244" width="136" height="50" rx="7" fill="rgba(255,255,255,.14)"/><text x="644" y="265" text-anchor="middle">Block Groups</text><text x="644" y="282" text-anchor="middle" opacity=".75">VM image data</text>
  </g>
</svg>
<figcaption>Every node talks only to the LUN. All coordination state lives on the LUN, in records small enough to be updated by one atomic compare-and-write.</figcaption>
</figure>

## The pieces

- **The kernel module** (`cetrafs.ko`) implements the filesystem: the namespace, file data, allocation, the cluster protocol, the journal, heartbeats and fencing, and the `/proc` interface.
- **`mkfs.cetra`** computes the geometry from the device size and writes every structure.
- **`fsck.cetra`** checks the volume offline in four passes and repairs only what has one correct answer.
- **`defrag.cetra`** asks the module to relocate a file into one contiguous run, online.

There is no daemon. The module does everything, and its only peer is the disk.

## The on-disk layout

```text
+----------------------------+
| Superblock                 |  block 0: every other region's offset is stored here
+----------------------------+
| Zone Group table           |  one block per Zone Group: owner node, free count
+----------------------------+
| Block Group table          |  one block per Block Group
+----------------------------+
| Global inode bitmap        |
+----------------------------+
| Global inode table         |  one inode record per 4 KiB block
+----------------------------+
| Node Registry              |  one 128-byte row per node, keyed by machine UUID
+----------------------------+
| Pending-free queues        |  one per Zone Group: frees handed to the owner
+----------------------------+
| Per-node journals          |  one private redo journal per registry row
+----------------------------+
| Block Group regions        |  header + data bitmap + data blocks, per Block Group
+----------------------------+
```

Nothing is found by position alone. Every region's offset is a superblock field, and the mount checks the whole map (no overlap, no wrap, everything inside the device), not just the checksum. The file `include/cetrafs.h` in the source tree is the complete specification of the format; the module and the tools both compile against it. See the [on-disk format reference](/docs/reference/on-disk-format/).

## Designed around a 512-byte atomic unit

The array performs compare-and-write atomically on one logical block, 512 bytes on a typical SAN LUN. cetrafs lays out its records to fit:

- Every record that nodes compete for (a Zone Group's owner, a registry row, an inode's lock fields) sits entirely in the **first 512 bytes of its own block**.
- **One inode per 4 KiB block**, even though an inode record is only about 200 bytes. With records packed together, one node's write could overwrite a neighbouring record another node had just changed. One record per block makes that impossible by construction.
- Blocks are a fixed **4 KiB**. A 512-byte block size was evaluated and rejected: it would mean roughly eight times as many metadata round trips and one directory entry per block.

## Three problems, three mechanisms

When several nodes share one disk, three different things can go wrong, and cetrafs handles each with its own mechanism. All three are built on the same primitive, atomic compare-and-write.

| Problem | Mechanism | Explained in |
|---|---|---|
| Two nodes allocate the same free block | **Zone Group ownership**: a node allocates only from regions it owns | [Zone Groups and allocation](/docs/concepts/allocation/) |
| Two nodes write the same file | **Whole-file exclusive open lock** | [Locking model](/docs/concepts/locking/) |
| Two nodes change the same directory, or one deletes a file another is using | **Per-inode namespace lock** plus lock-aware unlink and rename | [Locking model](/docs/concepts/locking/) |

Underneath them sit node liveness ([cluster coordination](/docs/concepts/coordination/)), crash recovery ([journaling](/docs/concepts/journaling/)), what happens when liveness gets it wrong ([fencing](/docs/concepts/fencing/)), and integrity checking ([checksums](/docs/concepts/integrity/)).
