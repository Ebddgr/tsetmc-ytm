(() => {
  'use strict';

  const FACE_VALUE = 1_000_000;
  const ROW_SELECTOR = '#main > div[id]';
  const ROW_CLASS = 'tsetmc-ytm-row';
  const CELL_CLASS = 'tsetmc-ytm-cell';
  const HEADER_CLASS = 'tsetmc-ytm-header';
  // Column positions verified against the live market watch (2026-10): rows
  // carry 23 cells; trailing cells 21/22 are ask volume/count, so the price
  // columns 8/20/21 (last/bid/ask) keep their original indices.
  const PRICE_CELLS = [
    { index: 7, key: 'last' },
    { index: 19, key: 'bid' },
    { index: 20, key: 'ask' },
  ];
  const ZERO_COUPON_WORDS = /اسناد\s*خزانه|اخزا|گام|گواهي\s*اعتبار|گواهی\s*اعتبار/i;
  let activeSort = null;
  // Re-sorting ~2,200 rows every poll starves the main thread on the live
  // board, so a tick only re-sorts when some YTM value actually changed.
  let sortDirty = true;
  const bondMetadata = new Map();
  // Pending symbols retry the worker hourly (matching the worker's own
  // negative-cache window) instead of being cached as permanently missing.
  const RETRY_PENDING_MS = 60 * 60_000;
  const PENDING_TITLE = 'در انتظار شناسه از IFB…';

  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

  function normalizeDigits(value) {
    return String(value)
      .replace(/[۰-۹]/g, digit => String(persianDigits.indexOf(digit)))
      .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)));
  }

  function parsePrice(value) {
    // اولین عددِ سلول = خود قیمت؛ متن برچسب YTM در محاسبه دخیل نیست.
    const match = normalizeDigits(value).match(/[\d,،]+/);
    if (!match) return null;
    const price = Number(match[0].replace(/[،,]/g, ''));
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  // Converts an Iranian Solar Hijri date (YYMMDD) to Gregorian UTC.
  function jalaliToGregorianUtc(year, month, day) {
    const jy = year < 100 ? year + 1400 : year;
    const jy2 = jy - 979;
    const days = 365 * jy2
      + Math.floor(jy2 / 33) * 8
      + Math.floor((jy2 % 33 + 3) / 4)
      + 78
      + day
      + (month < 7 ? (month - 1) * 31 : (month - 7) * 30 + 186);
    let gregorianDay = days;
    let gregorianYear = 1600 + 400 * Math.floor(gregorianDay / 146097);
    gregorianDay %= 146097;
    let leap = true;

    if (gregorianDay >= 36525) {
      gregorianDay--;
      gregorianYear += 100 * Math.floor(gregorianDay / 36524);
      gregorianDay %= 36524;
      if (gregorianDay >= 365) gregorianDay++;
      else leap = false;
    }

    gregorianYear += 4 * Math.floor(gregorianDay / 1461);
    gregorianDay %= 1461;
    if (gregorianDay >= 366) {
      leap = false;
      gregorianDay--;
      gregorianYear += Math.floor(gregorianDay / 365);
      gregorianDay %= 365;
    }

    const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gregorianMonth = 0;
    while (gregorianDay >= monthLengths[gregorianMonth]) {
      gregorianDay -= monthLengths[gregorianMonth++];
    }
    return Date.UTC(gregorianYear, gregorianMonth, gregorianDay + 1);
  }

  // YTM is a function of the trade date, not the wall clock: IFB's official
  // figures are evaluated as of the settlement day, so anchoring to the start
  // of the UTC day keeps values stable all day (matching official yields)
  // instead of drifting upward with time-of-day — during TSETMC trading hours
  // (09:00–15:00 Tehran = 05:30–11:30 UTC) the UTC date equals the Tehran
  // trade date. Measured effect before the anchor: اراد284 @ 916,050 on
  // 1405/07/10 read 40.21٪ in the afternoon vs the official 40.18٪.
  function startOfUtcDay(ms) {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  function extractMaturity(name) {
    const matches = normalizeDigits(name).match(/(?<!\d)(?:(0[3-9]|1[4-9])|14(?:0[3-9]|1[4-9]))\d{4}(?!\d)/g);
    if (!matches?.length) return null;
    const value = matches[matches.length - 1].slice(-6);
    const year = Number(value.slice(0, 2)) + 1400;
    const month = Number(value.slice(2, 4));
    const day = Number(value.slice(4, 6));
    if (month < 1 || month > 12 || day < 1 || day > daysInJalaliMonth(year, month)) return null;
    return { utc: jalaliToGregorianUtc(year, month, day), year, month, day };
  }

  function isJalaliLeap(year) {
    return jalaliToGregorianUtc(year + 1, 1, 1) - jalaliToGregorianUtc(year, 1, 1) === 366 * 86_400_000;
  }

  function daysInJalaliMonth(year, month) {
    if (month <= 6) return 31;
    if (month <= 11) return 30;
    return isJalaliLeap(year) ? 30 : 29;
  }

  function addJalaliMonths(date, months, keepMonthEnd = false) {
    const total = date.year * 12 + date.month - 1 + months;
    const year = Math.floor(total / 12);
    const month = total % 12 + 1;
    const day = keepMonthEnd
      ? daysInJalaliMonth(year, month)
      : Math.min(date.day, daysInJalaliMonth(year, month));
    return { year, month, day, utc: jalaliToGregorianUtc(year, month, day) };
  }

  function couponSchedule(issue, maturity, intervalMonths) {
    const payments = [];
    const keepMonthEnd = issue.day === daysInJalaliMonth(issue.year, issue.month);
    let current = { ...issue, utc: jalaliToGregorianUtc(issue.year, issue.month, issue.day) };
    while (current.utc < maturity.utc && payments.length < 80) {
      payments.push(current);
      current = addJalaliMonths(current, intervalMonths, keepMonthEnd);
    }
    if (payments.at(-1)?.utc !== maturity.utc) payments.push(maturity);
    return payments;
  }

  function accruedInterest(parValue, rate, paymentsPerYear, previous, next, now, schedule) {
    const previousUtc = previous.utc;
    const nextUtc = next.utc;
    const passedDays = Math.max(0, (now - previousUtc) / 86_400_000);
    const wholeDays = (nextUtc - previousUtc) / 86_400_000;
    const remainingDays = Math.max(0, (nextUtc - now) / 86_400_000);
    const previousIndex = schedule.indexOf(previous);
    const groupStart = previousIndex - (previousIndex % paymentsPerYear);
    const yearDays = isJalaliLeap(schedule[groupStart].year) ? 366 : 365;
    // The prorating adjustment divides by the *scheduled* coupon period, not
    // the actual one: a final stub (maturity falling before the next regular
    // coupon) still prorates over the full interval, as IFB does. Using the
    // truncated stub length overshot the adjustment and mispriced every
    // near-maturity bond (اراد203 read 40.37 vs the official 39.38; اراد98
    // 36.00 vs 35.88). Regular periods are untouched — there the scheduled
    // date *is* the next payment — so the 400+ matching rows stay identical.
    const scheduledNext = addJalaliMonths(previous, 12 / paymentsPerYear, schedule[0].day === daysInJalaliMonth(schedule[0].year, schedule[0].month));
    const periodDays = (scheduledNext.utc - previousUtc) / 86_400_000;
    // Day clamping can stack the schedule so the final payment lands one day
    // after the previous one (issue day 30 → 29 … maturity 30). The prorating
    // adjustment would then divide by zero and NaN every cash flow downstream,
    // so single-day periods take the coupon at face accrual instead.
    const adjustment = wholeDays > 1 && periodDays > 1
      ? ((rate / paymentsPerYear) * remainingDays) / (periodDays - 1)
      : 0;
    return (parValue * rate * passedDays / yearDays) * (1 - adjustment);
  }

  function couponBondYtm(cleanPrice, parValue, issue, maturity, rate, intervalMonths = 3, calculationUtc = Date.now()) {
    const now = calculationUtc;
    const paymentsPerYear = 12 / intervalMonths;
    const schedule = couponSchedule(issue, maturity, intervalMonths);
    const issueDay = schedule[0].utc;
    const atIssue = now === issueDay;
    // Last payment *on or before* settlement: a trade landing exactly on a
    // coupon date accrues 0 (same treatment as at-issue), matching the
    // reference figures — strictly-before charged a full period there and
    // mispriced on-coupon trades by up to 13.6 points (کرمان5126).
    const previousIndex = schedule.findLastIndex(payment => payment.utc <= now);
    const nextIndex = schedule.findIndex(payment => payment.utc > now);
    if ((!atIssue && previousIndex < 0) || nextIndex < 0) return null;
    const payments = schedule.slice(nextIndex);
    const dirtyPrice = atIssue
      ? cleanPrice
      : cleanPrice + accruedInterest(parValue, rate, paymentsPerYear, schedule[previousIndex], schedule[nextIndex], now, schedule);
    const presentValue = annualRate => payments.reduce((total, payment, index) => {
      const years = (payment.utc - now) / 31_536_000_000;
      const coupon = accruedInterest(parValue, rate, paymentsPerYear, schedule[nextIndex + index - 1], payment, payment.utc, schedule);
      const cashFlow = coupon + (index === payments.length - 1 ? parValue : 0);
      return total + cashFlow / Math.pow(1 + annualRate, years);
    }, 0);
    let low = -0.99;
    let high = 5;
    for (let i = 0; i < 100; i++) {
      const middle = (low + high) / 2;
      if (presentValue(middle) > dirtyPrice) low = middle;
      else high = middle;
    }
    // Landing on a search bound means no rate in (-99%, 500%) prices these
    // cash flows to the dirty price (or the stream is non-finite) — a real
    // yield converges strictly inside the range. Returning the bound itself
    // rendered "-99.00٪" to users (اراد115/116), so report "no value" and
    // let the cell stay blank.
    if (low <= -0.99 || high >= 5) return null;
    return ((low + high) / 2) * 100;
  }

  function calculateYtm(price, maturity, name, metadata, calculationUtc = Date.now()) {
    const now = startOfUtcDay(calculationUtc);
    const days = Math.ceil((maturity.utc - now) / 86_400_000);
    if (!price || days <= 0 || days > 10_000) return null;

    const parValue = metadata?.parValue || FACE_VALUE;
    const zeroCoupon = metadata
      ? metadata.rate === 0 || metadata.intervalMonths === 0
      : ZERO_COUPON_WORDS.test(name);
    if (zeroCoupon) {
      return { value: (Math.pow(parValue / price, 365 / days) - 1) * 100, days };
    }

    const rate = metadata?.rate;
    if (!Number.isFinite(rate) || rate <= 0 || !metadata?.issue || !metadata?.intervalMonths) return null;
    const issue = { ...metadata.issue, utc: jalaliToGregorianUtc(metadata.issue.year, metadata.issue.month, metadata.issue.day) };
    const value = couponBondYtm(price, parValue, issue, maturity, rate, metadata.intervalMonths, now);
    return Number.isFinite(value) && value > -100 && value < 500 ? { value, days } : null;
  }

  function makeYtmCell(key) {
    const cell = document.createElement('div');
    cell.className = `t0c5 ${CELL_CLASS}`;
    cell.dataset.ytmKey = key;
    return cell;
  }

  function ensureYtmCells(row) {
    const existing = Object.fromEntries(
      [...row.querySelectorAll(`:scope > .${CELL_CLASS}`)].map(cell => [cell.dataset.ytmKey, cell]),
    );
    const originalCells = [...row.children].filter(cell => !cell.classList.contains(CELL_CLASS));
    for (const { index, key } of PRICE_CELLS) {
      const priceCell = originalCells[index];
      if (!priceCell) continue;
      const ytmCell = existing[key] || makeYtmCell(key);
      priceCell.after(ytmCell);
    }
    return { originalCells, ytmCells: Object.fromEntries(
      [...row.querySelectorAll(`:scope > .${CELL_CLASS}`)].map(cell => [cell.dataset.ytmKey, cell]),
    ) };
  }

  function updateYtmCell(cell, priceCell, maturity, identity, metadata, calculationUtc = Date.now()) {
    const result = calculateYtm(parsePrice(priceCell.innerText), maturity, identity, metadata, calculationUtc);
    // Only a change in the displayed value can reorder the board; comparing
    // the raw value would re-sort on every invisible wiggle of the 3rd decimal.
    const text = result ? `${result.value.toFixed(2)}٪` : '';
    if (cell.textContent !== text) sortDirty = true;
    cell.textContent = text;
    cell.dataset.ytmValue = result ? String(result.value) : '';
    // IFB publishes its own YTM for listed bonds; surface it as a hover
    // tooltip for cross-checking without adding a column.
    const official = Number.isFinite(metadata?.referenceYtm) ? metadata.referenceYtm : null;
    if (official === null) cell.removeAttribute('title');
    else cell.title = `بازده رسمی IFB: ${official.toFixed(2)}٪`;
  }

  function updateRow(row) {
    const { originalCells: cells, ytmCells } = ensureYtmCells(row);
    if (cells.length < 21) return;
    const symbol = cells[0]?.innerText.trim() || '';
    const name = cells[1]?.innerText.trim() || '';
    const identity = `${symbol} ${name}`;
    const entry = bondMetadata.get(symbol);
    if (!entry || entry.pending) {
      row.classList.remove(ROW_CLASS);
      for (const cell of Object.values(ytmCells)) { cell.textContent = ''; cell.dataset.ytmValue = ''; cell.removeAttribute('title'); }
      const now = Date.now();
      if (chrome.runtime?.sendMessage && (!entry || now - entry.at >= RETRY_PENDING_MS)) {
        bondMetadata.set(symbol, { pending: true, at: now });
        try {
          chrome.runtime.sendMessage({ type: 'tsetmc-ytm-bond', symbol, name }, response => {
            if (chrome.runtime.lastError) return;
            // Still unresolved: the pending entry stays and the ask repeats
            // after RETRY_PENDING_MS, so an unreachable IFB never becomes a
            // permanent blank for a bond that lists there later.
            if (response?.status !== 'ok' || !response.metadata) return;
            bondMetadata.set(symbol, response.metadata);
            // Refresh every row carrying this symbol, not just the asker —
            // the same instrument can appear in more than one row.
            for (const rowEl of document.querySelectorAll(ROW_SELECTOR)) {
              const first = [...rowEl.children].filter(cell => !cell.classList.contains(CELL_CLASS))[0];
              if (first?.innerText.trim() === symbol) updateRow(rowEl);
            }
          });
        } catch { /* extension context invalidated, e.g. after a reload */ bondMetadata.delete(symbol); }
      } else if (entry) {
        for (const cell of Object.values(ytmCells)) cell.title = PENDING_TITLE;
      }
      return;
    }
    const metadata = entry;
    row.classList.add(ROW_CLASS);

    const officialMaturity = metadata?.maturity;
    const maturity = officialMaturity
      ? { ...officialMaturity, utc: jalaliToGregorianUtc(officialMaturity.year, officialMaturity.month, officialMaturity.day) }
      : extractMaturity(name);
    if (!maturity) return;

    for (const { index, key } of PRICE_CELLS) {
      if (cells[index] && ytmCells[key]) updateYtmCell(ytmCells[key], cells[index], maturity, identity, metadata);
    }

  }

  function applySort(key, ascending) {
    const main = document.querySelector('#main');
    if (!main) return;
    const rows = [...main.querySelectorAll(':scope > div[id]')];
    rows.sort((a, b) => {
      const aValue = a.querySelector(`:scope > .${CELL_CLASS}[data-ytm-key="${key}"]`)?.dataset.ytmValue || '';
      const bValue = b.querySelector(`:scope > .${CELL_CLASS}[data-ytm-key="${key}"]`)?.dataset.ytmValue || '';
      const av = Number(aValue);
      const bv = Number(bValue);
      const aValid = aValue !== '' && Number.isFinite(av);
      const bValid = bValue !== '' && Number.isFinite(bv);
      if (aValid !== bValid) return aValid ? -1 : 1;
      const difference = aValid ? (ascending ? av - bv : bv - av) : 0;
      return difference || String(a.id).localeCompare(String(b.id));
    });
    // Moving ~2,200 nodes janks the live board for seconds; skip the pass
    // when the DOM already matches the target order.
    const currentIds = [...main.querySelectorAll(':scope > div[id]')].map(row => row.id);
    if (currentIds.length === rows.length && currentIds.every((id, i) => id === rows[i].id)) return;
    rows.forEach(row => main.append(row));
  }

  function sortByYtm(key, header) {
    const ascending = activeSort?.key === key ? !activeSort.ascending : true;
    activeSort = { key, ascending };
    sortDirty = true;
    document.querySelectorAll(`.${HEADER_CLASS}`).forEach(item => {
      item.dataset.direction = '';
      item.removeAttribute('data-sort-mark');
    });
    header.dataset.direction = ascending ? 'asc' : 'desc';
    header.dataset.sortMark = ascending ? '▲' : '▼';
    applySort(key, ascending);
  }

  function addHeader(after, key) {
    if (!after || after.nextElementSibling?.dataset.ytmKey === key) return;
    const header = document.createElement('div');
    header.className = `t0head ${HEADER_CLASS}`;
    header.dataset.ytmKey = key;
    header.textContent = 'YTM';
    header.addEventListener('click', () => sortByYtm(key, header));
    after.after(header);
  }

  function setupHeaders() {
    const top = document.querySelector('#header0');
    const detail = document.querySelector('#header1');
    if (!top || !detail || detail.querySelector(`.${HEADER_CLASS}`)) return;
    [top.children[7], top.children[13], top.children[14]].forEach(group => {
      if (group) group.style.width = `${parseInt(group.style.width, 10) + 55}px`;
    });
    const original = [...detail.children];
    addHeader(original[1], 'last');
    addHeader(original[10], 'bid');
    addHeader(original[11], 'ask');
  }

  function refresh() {
    setupHeaders();
    document.querySelectorAll(ROW_SELECTOR).forEach(updateRow);
    if (activeSort && sortDirty) {
      applySort(activeSort.key, activeSort.ascending);
      sortDirty = false;
    }
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__TSETMC_YTM_TEST__ = { jalaliToGregorianUtc, startOfUtcDay, couponSchedule, accruedInterest, couponBondYtm, calculateYtm, updateYtmCell, extractMaturity };
  }
  if (typeof document === 'undefined') return;

  // Polling only: a document-wide observer would see this extension's own
  // badges and cause an endless redraw loop.
  refresh();
  setInterval(refresh, 5_000);
})();
