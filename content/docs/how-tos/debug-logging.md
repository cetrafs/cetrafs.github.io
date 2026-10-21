---
weight: 380
title: "Turn on debug logging"
description: "Enable the full cetrafs trace at runtime with dynamic debug, narrow it to a file or function, and turn it off again. No rebuild or remount needed."
toc: true
---

By default, cetrafs logs only errors, warnings and lifecycle events (mount, unmount, Zone Group claims, lease revocations, journal replays, `controls` changes). A full mount and unmount produces about seven lines. Everything per-operation is compiled in at `pr_debug` level and switched off.

## Turn the trace on

This uses the kernel's dynamic debug facility (`CONFIG_DYNAMIC_DEBUG`, enabled on Debian and Proxmox kernels):

```sh
# everything the module can say
echo 'module cetrafs +p' | sudo tee /sys/kernel/debug/dynamic_debug/control
```

Narrow it down:

```sh
echo 'file dir.c +p'          | sudo tee /sys/kernel/debug/dynamic_debug/control
echo 'func cetrafs_lookup +p' | sudo tee /sys/kernel/debug/dynamic_debug/control
```

Add the function name and line number to each message:

```sh
echo 'module cetrafs +pfl' | sudo tee /sys/kernel/debug/dynamic_debug/control
```

## Turn it off

```sh
echo 'module cetrafs -p' | sudo tee /sys/kernel/debug/dynamic_debug/control
```

## See what's available

```sh
sudo grep cetrafs /sys/kernel/debug/dynamic_debug/control
```

Settings are cleared when the module unloads and aren't kept across a reboot. To enable the trace from module load, pass `dyndbg`:

```sh
sudo modprobe cetrafs dyndbg='+p'
```

{{< callout type="warning" >}}
The full trace is verbose: it logs every lookup, create, journal transaction and lock timing. Turn it on while you diagnose a problem and off afterwards.
{{< /callout >}}

On a kernel built **without** `CONFIG_DYNAMIC_DEBUG`, the debug lines are compiled out, and getting them back means rebuilding the module with `-DDEBUG`.
