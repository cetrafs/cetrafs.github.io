// Shows the GitHub star count next to the topbar repo link once it reaches
// data-stars-min. The count is cached for an hour per visitor, to stay well
// inside GitHub's unauthenticated API limit (60 requests per hour per IP).
(function () {
  var link = document.querySelector(".repo-link[data-repo]");
  if (!link) return;
  var repo = link.getAttribute("data-repo");
  var min = parseInt(link.getAttribute("data-stars-min"), 10);
  if (isNaN(min)) min = 25;
  var KEY = "cf-stars:" + repo;
  var TTL = 3600 * 1000;

  function show(n) {
    if (typeof n !== "number" || n < min) return;
    var label = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
    link.querySelector(".repo-stars-n").textContent = label;
    link.querySelector(".repo-stars").hidden = false;
    link.setAttribute("aria-label", "cetrafs on GitHub, " + n + " stars");
    link.setAttribute("title", "cetrafs on GitHub: " + n + " stars");
  }

  try {
    var cached = JSON.parse(localStorage.getItem(KEY) || "null");
    if (cached && Date.now() - cached.t < TTL) { show(cached.n); return; }
  } catch (e) {}

  fetch("https://api.github.com/repos/" + repo, { headers: { Accept: "application/vnd.github+json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== "number") return;
      try { localStorage.setItem(KEY, JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (e) {}
      show(d.stargazers_count);
    })
    .catch(function () {});
})();
