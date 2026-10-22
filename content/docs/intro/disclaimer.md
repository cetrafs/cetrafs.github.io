---
weight: 40
title: "Warranty and liability"
linkTitle: "Disclaimer"
description: "cetrafs is free software provided as is, without warranty. You decide where to run it, so testing it on your own storage and protecting your data is up to you."
toc: false
---

cetrafs is free software, shared in the hope that it is useful. Like all software under the GPL, it comes **without any warranty**: you get it as is, and the decision to use it, and where, is yours.

In practice, that means:

- **You test it on your own setup.** Storage arrays, multipath configurations, kernels and hypervisors differ, and no test suite covers every combination. Before cetrafs holds data you care about, validate it on your own hardware, as described in [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).
- **You look after your data.** Keep independent backups on other storage, and have a plan for restoring them. This is good practice with any filesystem, and more so with a young one.
- **The documentation is best effort.** It is written carefully and checked against the code, but it can be incomplete or out of date. When the docs and the code disagree, the code is what runs.

To the extent permitted by applicable law, Massimo Cetra and the contributors to cetrafs are not liable for any loss or damage arising from the use of cetrafs or of this documentation, including data loss, corruption or downtime. The full terms are in sections 11 and 12 of the [GNU General Public License, version 2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html), and in section 5 of [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) for the documentation.

Found a problem? Reports help everyone. Open an issue in the [cetrafs repository](https://github.com/cetrafs/cetrafs/issues).
