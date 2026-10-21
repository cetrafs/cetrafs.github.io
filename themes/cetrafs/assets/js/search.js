(function () {
  var input = document.getElementById("cf-search-input");
  var results = document.getElementById("cf-search-results");
  if (!input || !results) return;

  var index = null;
  var activeIndex = -1;

  function loadIndex() {
    if (index) return Promise.resolve(index);
    return fetch("/index.json")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        index = data.map(function (entry) {
          return {
            title: entry.title,
            section: entry.section,
            url: entry.url,
            description: entry.description || "",
            body: (entry.body || "").toLowerCase(),
            haystack: (entry.title + " " + (entry.description || "") + " " + (entry.body || "")).toLowerCase()
          };
        });
        return index;
      });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function highlight(text, terms) {
    var out = escapeHtml(text);
    terms.forEach(function (t) {
      if (!t) return;
      var re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
      out = out.replace(re, "<mark>$1</mark>");
    });
    return out;
  }

  function excerptAround(body, term) {
    var pos = term ? body.indexOf(term) : -1;
    if (pos === -1) return body.slice(0, 120);
    var start = Math.max(0, pos - 40);
    return (start > 0 ? "…" : "") + body.slice(start, start + 140) + "…";
  }

  function score(entry, terms) {
    var s = 0;
    var titleLower = entry.title.toLowerCase();
    terms.forEach(function (t) {
      if (!t) return;
      if (titleLower === t) s += 50;
      else if (titleLower.indexOf(t) === 0) s += 30;
      else if (titleLower.indexOf(t) !== -1) s += 15;
      if (entry.description.toLowerCase().indexOf(t) !== -1) s += 5;
      if (entry.body.indexOf(t) !== -1) s += 1;
    });
    return s;
  }

  function render(matches, terms) {
    if (!matches.length) {
      results.innerHTML = '<div class="search-empty">No results</div>';
      results.classList.add("open");
      return;
    }
    results.innerHTML = matches.slice(0, 8).map(function (m) {
      var excerpt = excerptAround(m.body, terms[0]);
      return (
        '<a href="' + m.url + '">' +
        '<div class="r-section">' + escapeHtml(m.section || "") + "</div>" +
        '<div class="r-title">' + highlight(m.title, terms) + "</div>" +
        '<div class="r-excerpt">' + highlight(excerpt, terms) + "</div>" +
        "</a>"
      );
    }).join("");
    results.classList.add("open");
    activeIndex = -1;
  }

  function doSearch(query) {
    var terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      results.classList.remove("open");
      return;
    }
    loadIndex().then(function (idx) {
      var matches = idx
        .map(function (entry) { return { entry: entry, s: score(entry, terms) }; })
        .filter(function (m) { return m.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .map(function (m) { return m.entry; });
      render(matches, terms);
    });
  }

  var debounceTimer;
  input.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    var q = input.value;
    debounceTimer = setTimeout(function () { doSearch(q); }, 120);
  });

  input.addEventListener("focus", function () {
    if (input.value.trim()) doSearch(input.value);
  });

  input.addEventListener("keydown", function (e) {
    var items = results.querySelectorAll("a");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) {
        window.location.href = items[activeIndex].getAttribute("href");
      }
      return;
    } else if (e.key === "Escape") {
      results.classList.remove("open");
      return;
    } else {
      return;
    }
    items.forEach(function (it, i) { it.classList.toggle("active", i === activeIndex); });
    if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: "nearest" });
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".search-box")) {
      results.classList.remove("open");
    }
  });
})();
