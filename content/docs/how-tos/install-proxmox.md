---
weight: 306
title: "Install cetrafs on Proxmox VE"
linkTitle: "Install on Proxmox VE"
description: "Quick install of the cetrafs packages and the pve-storage-cetrafs storage plugin from their GitHub releases, on every node of a Proxmox VE cluster."
toc: true
---

A Proxmox VE node needs three packages, all published as GitHub releases:

| Package | From | Contents |
|---|---|---|
| `cetrafs-dkms` | [cetrafs releases](https://github.com/cetrafs/cetrafs/releases) | The kernel module, built by DKMS for each kernel. |
| `cetrafs-tools` | [cetrafs releases](https://github.com/cetrafs/cetrafs/releases) | `mkfs.cetra`, `fsck.cetra` and `defrag.cetra`. |
| `pve-storage-cetrafs` | [cetrafs-proxmox releases]({{< param pluginRepoURL >}}/releases) | The Proxmox VE storage plugin: adds a `cetrafs` storage type. |

The [storage plugin](/docs/how-tos/proxmox-plugin/) is optional but recommended. Without it, you mount the volume yourself and register it as directory storage, as in the [Proxmox datastore tutorial](/docs/tutorials/proxmox-datastore/).

## Install on every node

{{< callout type="warning" title="Every node, not just one" >}}
cetrafs and the plugin must be installed on **every** node of the cluster before you add a `cetrafs` storage. The storage configuration is shared by the whole cluster, and a node without the plugin can't use, or even parse, a `cetrafs` entry. A node without the module can't mount the volume.
{{< /callout >}}

### 1. Download the packages, on one node

As root, on any one node:

```sh
export VER={{< version >}} PVER={{< param pluginVersion >}}
mkdir -p /root/cetrafs-$VER && cd /root/cetrafs-$VER

URL=https://github.com/cetrafs/cetrafs/releases/download/$VER
curl -fsSL --remote-name-all $URL/cetrafs-dkms_${VER}_all.deb $URL/cetrafs-tools_${VER}_amd64.deb
curl -fsSL --remote-name-all {{< param pluginRepoURL >}}/releases/download/$PVER/pve-storage-cetrafs_${PVER}_all.deb
```

### 2. Install them on that node

```sh
(
    if [ -z "$VER" ] || [ -z "$PVER" ]; then
        echo "VER and PVER are not set: run the export line from step 1 first" >&2
        exit 1
    fi
    cd /root/cetrafs-$VER

    apt-get install -y proxmox-default-headers          # kernel headers, so DKMS can build the module
    apt-get install -y ./cetrafs-dkms_${VER}_all.deb ./cetrafs-tools_${VER}_amd64.deb \
                   ./pve-storage-cetrafs_${PVER}_all.deb
)
```

### 3. Copy them to the other nodes

Cluster nodes already trust each other's root SSH keys, so the same node can copy the packages to the rest of the cluster. On the node where you downloaded them:

```sh
(
    if [ -z "$VER" ] || [ -z "$PVER" ]; then
        echo "VER and PVER are not set: run the export line from step 1 first" >&2
        exit 1
    fi
    cd /root/cetrafs-$VER

    # every other node of the cluster, as "name address", from corosync.conf
    NODES=$(awk '/^[[:space:]]*name:/ {n=$2} /ring0_addr:/ {print n, $2}' /etc/pve/corosync.conf |
            grep -v "^$(hostname) ")

    echo "$NODES" | while read -r node addr; do
        echo "=== $node ($addr)"
        ssh -n -o HostKeyAlias=$node -o UserKnownHostsFile=/etc/pve/nodes/$node/ssh_known_hosts \
            root@$addr "mkdir -p /root/cetrafs-$VER" &&
        scp -q -o HostKeyAlias=$node -o UserKnownHostsFile=/etc/pve/nodes/$node/ssh_known_hosts \
            ./*.deb root@$addr:/root/cetrafs-$VER/
    done
)
```

Each node's host key is checked against the one the cluster has recorded for it, the way Proxmox's own migrations do.

### 4. Install them on the other nodes

Log in to each of the other nodes and run the `export` line from step 1, then step 2.

Or let the node where you downloaded them do it over SSH:

```sh
(
    if [ -z "$VER" ] || [ -z "$PVER" ]; then
        echo "VER and PVER are not set: run the export line from step 1 first" >&2
        exit 1
    fi

    # every other node of the cluster, as "name address", from corosync.conf
    NODES=$(awk '/^[[:space:]]*name:/ {n=$2} /ring0_addr:/ {print n, $2}' /etc/pve/corosync.conf |
            grep -v "^$(hostname) ")

    echo "$NODES" | while read -r node addr; do
        echo "=== $node ($addr)"
        ssh -n -o HostKeyAlias=$node -o UserKnownHostsFile=/etc/pve/nodes/$node/ssh_known_hosts \
            root@$addr "cd /root/cetrafs-$VER &&
                apt-get install -y proxmox-default-headers &&
                apt-get install -y ./cetrafs-dkms_${VER}_all.deb ./cetrafs-tools_${VER}_amd64.deb ./pve-storage-cetrafs_${PVER}_all.deb" ||
        echo "*** $node FAILED: install it there by hand, with step 2"
    done
)
```

It installs the packages on one node after another, and reports any node where the install fails.

### About the packages

`proxmox-default-headers` follows the default Proxmox kernel series, so the headers for each new kernel arrive with the kernel and DKMS rebuilds the module automatically. If a node runs a kernel other than the default one, install its headers too: `apt-get install -y proxmox-headers-$(uname -r)`.

Installing the plugin restarts the Proxmox API services (`pvedaemon`, `pveproxy`, `pvestatd`, `pvescheduler`) so they load it. Running guests are not affected.

## Verify

From any node, check every node of the cluster, this one included. Each node prints one line:

```sh
awk '/^[[:space:]]*name:/ {n=$2} /ring0_addr:/ {print n, $2}' /etc/pve/corosync.conf |
while read -r node addr; do
    printf '%-12s ' "$node"
    ssh -n -o HostKeyAlias=$node -o UserKnownHostsFile=/etc/pve/nodes/$node/ssh_known_hosts \
        root@$addr '
            for p in cetrafs-dkms cetrafs-tools pve-storage-cetrafs; do
                s=$(dpkg-query -W -f="\${db:Status-Abbrev}\${Version}" $p 2>/dev/null)
                case "$s" in
                    ii*) printf "%s=%s " $p "${s#ii }" ;;
                    *)   printf "%s=MISSING " $p ;;
                esac
            done
            if dkms status cetrafs -k "$(uname -r)" 2>/dev/null | grep -q installed
            then echo "module=built"
            else echo "module=NOT-BUILT"
            fi' ||
    echo "UNREACHABLE"
done
```

A healthy cluster looks like this, with the same versions on every node:

```text
pve1         cetrafs-dkms={{< version >}} cetrafs-tools={{< version >}} pve-storage-cetrafs={{< param pluginVersion >}} module=built
pve2         cetrafs-dkms={{< version >}} cetrafs-tools={{< version >}} pve-storage-cetrafs={{< param pluginVersion >}} module=built
pve3         cetrafs-dkms={{< version >}} cetrafs-tools={{< version >}} pve-storage-cetrafs={{< param pluginVersion >}} module=built
```

`MISSING` means that package isn't installed on the node. `module=NOT-BUILT` means DKMS has no module for the kernel the node is running: install that kernel's headers (`apt-get install -y proxmox-headers-$(uname -r)`) and check `dkms status cetrafs` there.

## Upgrade

Download the new releases and install them the same way, on every node: steps 1 to 4 above work for upgrades too. Keep `cetrafs-dkms` and `cetrafs-tools` at the same version on all nodes. Read the cetrafs release notes first: if the on-disk format version changed, you have to [move the data and reformat](/docs/how-tos/upgrade-reformat/).

A new `cetrafs-dkms` builds the new module, but a mounted volume keeps running the old one until it is unmounted and the module is reloaded. The simplest way is to migrate the guests away and reboot the node, one node at a time.

## Next

- [Check that the LUN supports atomic CAW](/docs/how-tos/check-caw/).
- [Add cetrafs storage with the Proxmox plugin](/docs/how-tos/proxmox-plugin/).
- [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).
