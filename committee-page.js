(function () {
  const slug = document.body.dataset.committee;
  const committee = slug && window.VMMUN_COMMITTEES && window.VMMUN_COMMITTEES[slug];
  const main = document.querySelector('#main');

  document.querySelector('.menu')?.addEventListener('click', (event) => {
    const nav = document.querySelector('nav');
    const open = nav.classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('nav a').forEach((link) => {
    link.addEventListener('click', () => document.querySelector('nav')?.classList.remove('open'));
  });

  document.querySelectorAll('.reveal').forEach((element) => {
    element.classList.add('visible');
  });

  if (!committee || !main) {
    if (main) {
      main.innerHTML =
        '<p class="label">CHAMBER NOT FOUND</p><h2>Return to the <a href="../index.html#committees">committee roster</a>.</h2>';
    }
    return;
  }

  document.title = `${committee.code} | VMMUN 2026`;

  const others = Object.values(window.VMMUN_COMMITTEES)
    .filter((item) => item.slug !== committee.slug)
    .map(
      (item) =>
        `<a href="${item.slug}.html">${item.code}<span>${item.name}</span></a>`
    )
    .join('');

  const ebList = Array.isArray(committee.executiveBoard) && committee.executiveBoard.length
    ? committee.executiveBoard.join(' · ')
    : 'To be announced';

  const ebCards = Array.isArray(committee.executiveBoard) && committee.executiveBoard.length
    ? `
    <div class="committee-eb-section reveal visible">
      <p class="label">EXECUTIVE BOARD</p>
      <div class="committee-eb-grid">
        ${committee.executiveBoard
      .map((name) => {
        const initials = name
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase();
        return `
              <div class="committee-eb-card">
                <div class="committee-eb-avatar">${escapeHtml(initials)}</div>
                <div class="committee-eb-name">${escapeHtml(name)}</div>
                <div class="committee-eb-role">CHAIRPERSON</div>
              </div>
            `;
      })
      .join('')}
      </div>
    </div>`
    : '';

  main.innerHTML = `
    <p class="label">${committee.roman} · ${committee.category}</p>
    <h1 class="committee-title">${committee.code}</h1>
    <p class="committee-subtitle">${escapeHtml(committee.name)}</p>
    <p class="lede dark committee-blurb">${escapeHtml(committee.blurb)}</p>
    <div class="committee-facts reveal visible">
      <div><b>${escapeHtml(committee.detailLabel)}</b><p>${escapeHtml(committee.detail)}</p></div>
      <div><b>EXPERIENCE</b><p>${escapeHtml(committee.experience)}</p></div>
      <div><b>EXECUTIVE BOARD</b><p>${escapeHtml(ebList)}</p></div>
      <div><b>CONFERENCE</b><p>${escapeHtml(window.VMMUN_DATES.short)}</p></div>
    </div>
    ${ebCards}
    <p class="committee-actions">
      <a class="button" href="../index.html#register">Register for ${escapeHtml(committee.code)} →</a>
      <a class="button bare" href="../index.html#committees">← All committees</a>
    </p>
    <div class="committee-siblings">
      <p class="label">OTHER CHAMBERS</p>
      <div class="committee-nav">${others}</div>
    </div>
  `;

  function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = value || '';
    return element.innerHTML;
  }
})();
