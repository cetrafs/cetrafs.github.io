(function () {
  var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';

  document.querySelectorAll(".docs-content pre").forEach(function (pre) {
    var container = pre.closest(".highlight") || pre;
    if (container.querySelector(".code-copy-btn")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.innerHTML = COPY_ICON + "<span>Copy</span>";
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(pre.innerText).then(function () {
        btn.innerHTML = CHECK_ICON + "<span>Copied</span>";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.innerHTML = COPY_ICON + "<span>Copy</span>";
          btn.classList.remove("copied");
        }, 1800);
      });
    });
    container.style.position = "relative";
    container.appendChild(btn);
  });
})();
