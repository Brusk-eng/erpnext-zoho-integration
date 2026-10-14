frappe.pages["zoho-campaigns-dashboard"].on_page_load = function (wrapper) {
	const API = "erpnext_zoho_integration.erpnext_zoho_integration.api.dashboard.";
	const BLUE = "#2490ef";
	const GREEN = "#5cb85c";
	const PERIODS = { "30 Days": 30, "90 Days": 90, "180 Days": 180, "1 Year": 365, "All time": 0 };

	const esc = (s) => frappe.utils.escape_html(String(s ?? ""));
	const whole = (n) => new Intl.NumberFormat("en-IN").format(Math.round(n || 0));
	const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

	inject_styles();

	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Zoho Campaigns"), single_column: true });
	let ready = false;

	const get_days = () => {
		const v = PERIODS[page.fields_dict.period ? page.fields_dict.period.get_value() : "90 Days"];
		return v === undefined ? 90 : v; // 0 means "All time"
	};

	// ---- toolbar: Sync Now + Refresh + Period drive the whole page
	page.set_primary_action(
		__("Sync Now"),
		() =>
			frappe.call({
				method: API + "sync_now",
				freeze: true,
				freeze_message: __("Queuing sync..."),
				callback(r) {
					if (!r.exc)
						frappe.show_alert({
							message: __("Sync started in the background. Hit Refresh in a minute or two."),
							indicator: "blue",
						});
				},
			}),
		"refresh-cw"
	);
	page.set_secondary_action(__("Refresh"), () => load(), "refresh");
	page.add_field({
		fieldtype: "Select",
		label: __("Period"),
		fieldname: "period",
		options: Object.keys(PERIODS).join("\n"),
		default: "All time",
		change() {
			if (ready) load();
		},
	});

	const $root = $('<div class="zc"></div>').appendTo(page.main);
	ready = true;
	load();

	function load() {
		$root.html(`<div class="zc-skeleton"></div>`);
		frappe.call({
			method: API + "get_dashboard",
			args: { days: get_days() },
			callback(r) {
				if (r.exc || !r.message) return;
				render(r.message);
			},
			error() {
				$root.html(`<div class="zc-card"><p class="zc-empty">${__("Couldn't load the dashboard. Check the Error Log.")}</p></div>`);
			},
		});
	}

	// ------------------------------------------------------------------ render

	function render(d) {
		const t = d.totals;
		const kpis = [
			[__("Campaigns"), whole(t.campaigns)],
			[__("Emails sent"), whole(t.sent)],
			[__("Avg open rate"), pct(t.open_rate)],
			[__("Avg click rate"), pct(t.click_rate)],
			[__("Bounces"), whole(t.bounces)],
			[__("Unsubscribes"), whole(t.unsubs)],
		];
		const has = d.rows.length > 0;
		const none = d.synced && d.synced.total
			? __("{0} synced campaign(s) exist, the latest sent {1}. Try a wider period such as All time.", [d.synced.total, d.synced.latest])
			: __("No campaigns synced yet. Use Sync Now.");

		$root.html(`
			<div class="zc-kpis">${kpis
				.map(([l, v]) => `<div class="zc-kpi"><span>${esc(l)}</span><b>${v}</b></div>`)
				.join("")}</div>
			<div class="zc-grid">
				${card(__("Open and click rate by campaign"), 8, has ? `<div class="zc-chart"></div>` : empty(none))}
				${card(__("Recipient actions"), 4, d.actions.length ? bars(d.actions) : empty(none))}
				${card(__("Campaign performance"), 12, has ? campaign_table(d.rows) : empty(none))}
				${card(__("Top countries (opened or clicked)"), 4, d.countries.length ? bars(d.countries) : empty(none))}
				${card(__("Top cities (opened or clicked)"), 4, d.cities.length ? bars(d.cities) : empty(none))}
				${card(__("Sync health"), 4, health(d.health))}
				${card(__("Most engaged contacts"), 12, d.contacts.length ? contact_table(d.contacts) : empty(none))}
			</div>
			${cap_note(d)}
			<div class="text-muted small zc-stamp">${
				d.health.last_synced ? __("Last synced from Zoho: ") + esc(d.health.last_synced) : __("No successful sync recorded yet.")
			}</div>`);

		if (has) draw_trend(d.trend);
	}

	function draw_trend(tr) {
		const few = tr.labels.length <= 7; // few campaigns: bars named by campaign; many: line by date
		new frappe.Chart($root.find(".zc-chart")[0], {
			type: few ? "bar" : "line",
			height: 240,
			colors: [BLUE, GREEN],
			data: {
				labels: few ? tr.labels.map((l) => (l.length > 18 ? l.slice(0, 17) + "…" : l)) : tr.dates,
				datasets: [
					{ name: __("Open rate"), values: tr.open_rate },
					{ name: __("Click rate"), values: tr.click_rate },
				],
			},
			barOptions: { spaceRatio: 0.4 },
			lineOptions: { regionFill: 1, hideDots: tr.labels.length > 20 ? 1 : 0 },
			axisOptions: { xIsSeries: 1 },
			tooltipOptions: { formatTooltipY: (v) => `${v}%` },
		});
	}

	// ------------------------------------------------------------------ pieces

	function card(title, span, body) {
		return `<section class="zc-card zc-span-${span}"><h3>${esc(title)}</h3>${body}</section>`;
	}

	function empty(msg) {
		return `<p class="zc-empty">${esc(msg)}</p>`;
	}

	function bars(rows) {
		const max = Math.max(...rows.map((r) => r.value), 1);
		return `<div class="zc-bars">${rows
			.map(
				(r) => `<div class="zc-row">
					<span class="zc-label" title="${esc(r.label)}">${esc(r.label)}</span>
					<span class="zc-track"><i style="width:${((r.value / max) * 100).toFixed(1)}%"></i></span>
					<span class="zc-val">${whole(r.value)}</span></div>`
			)
			.join("")}</div>`;
	}

	function campaign_table(rows) {
		const num = (h) => `<th class="zc-num">${h}</th>`;
		return `<table class="zc-table">
			<colgroup><col>${'<col style="width:84px">'.repeat(7)}</colgroup>
			<thead><tr><th>${__("Campaign")}</th>${[__("Sent"), __("Delivered"), __("Open %"), __("Click %"), __("Bounce %"), __("Unsubs"), __("Spam")].map(num).join("")}</tr></thead>
			<tbody>${rows
				.map(
					(r) => `<tr>
					<td><a href="/app/campaign/${encodeURIComponent(r.name)}">${esc(r.title)}</a>
						<small>${esc(r.subject)}${r.subject && r.sent_time ? " · " : ""}${esc(r.sent_time)}</small></td>
					<td class="zc-num">${whole(r.sent)}</td>
					<td class="zc-num">${whole(r.delivered)}</td>
					<td class="zc-num">${pct(r.open_rate)}</td>
					<td class="zc-num">${pct(r.click_rate)}</td>
					<td class="zc-num">${pct(r.bounce_rate)}</td>
					<td class="zc-num">${whole(r.unsubs)}</td>
					<td class="zc-num">${whole(r.complaints)}</td></tr>`
				)
				.join("")}</tbody></table>`;
	}

	function contact_table(rows) {
		return `<table class="zc-table">
			<colgroup><col><col><col style="width:130px"><col style="width:130px"></colgroup>
			<thead><tr><th>${__("Contact")}</th><th>${__("Company")}</th>
				<th class="zc-num">${__("Campaigns opened")}</th><th class="zc-num">${__("Campaigns clicked")}</th></tr></thead>
			<tbody>${rows
				.map((r) => {
					const name = esc(r.full_name || r.email);
					const link = r.contact ? `<a href="/app/contact/${encodeURIComponent(r.contact)}">${name}</a>` : name;
					return `<tr><td>${link}<small>${esc(r.full_name ? r.email : "")}</small></td>
						<td>${esc(r.company_name)}</td>
						<td class="zc-num">${whole(r.opened)}</td><td class="zc-num">${whole(r.clicked)}</td></tr>`;
				})
				.join("")}</tbody></table>`;
	}

	function health(h) {
		const line = (k, v) => `<div class="zc-hrow"><span>${k}</span><b>${v}</b></div>`;
		let html = line(__("Integration"), `<i class="zc-dot ${h.is_active ? "on" : "off"}"></i>${h.is_active ? __("Active") : __("Inactive")}`);
		html += line(__("Last sync"), esc(h.last_synced || __("Never")));
		if (h.token_expiry) html += line(__("Token expires"), esc(h.token_expiry));
		if (h.errors_visible) {
			html += line(__("Sync errors"), h.error_count ? `<span class="zc-bad">${whole(h.error_count)}</span>` : "0");
			html += h.errors.length
				? `<div class="zc-errs">${h.errors
						.map((e) => `<a href="/app/error-log/${encodeURIComponent(e.name)}" title="${esc(e.title)}">${esc(e.title)}<small>${esc(e.when)}</small></a>`)
						.join("")}</div>`
				: "";
		}
		return `<div class="zc-health">${html}</div>`;
	}

	function cap_note(d) {
		const notes = [];
		if (d.synced && d.synced.missing_sent_time)
			notes.push(__("{0} campaign(s) have no Zoho sent time stored, so they are placed by the date they were first synced.", [d.synced.missing_sent_time]));
		if (d.capped_campaigns)
			notes.push(__("Country, city and contact cards are built from up to {0} contacts per action per campaign (what the sync stores). {1} campaign(s) in this period reached that limit, so those cards are a sample. Campaign totals above come from Zoho's own reports and are complete.", [d.recipient_cap, d.capped_campaigns]));
		return notes.length ? `<p class="zc-note">${notes.map(esc).join(" ")}</p>` : "";
	}

	// ------------------------------------------------------------------ styles

	function inject_styles() {
		if (document.getElementById("zc-style")) return;
		const css = `
		.zc .zc-skeleton{height:220px;border-radius:var(--border-radius-md);background:var(--control-bg)}
		.zc .zc-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:12px}
		.zc .zc-kpi{background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--border-radius-md);padding:12px 16px}
		.zc .zc-kpi span{display:block;color:var(--text-muted);font-size:var(--text-sm)}
		.zc .zc-kpi b{display:block;font-size:var(--text-2xl);font-weight:600;color:var(--text-color)}
		.zc .zc-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}
		.zc .zc-card{background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--border-radius-md);padding:14px 16px;min-width:0}
		.zc .zc-card h3{font-size:var(--text-md);font-weight:600;margin:0 0 10px;color:var(--text-color)}
		.zc .zc-span-4{grid-column:span 4}.zc .zc-span-8{grid-column:span 8}.zc .zc-span-12{grid-column:span 12}
		@media (max-width:1200px){.zc .zc-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.zc .zc-span-4,.zc .zc-span-8{grid-column:span 6}}
		@media (max-width:700px){.zc .zc-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.zc .zc-span-4,.zc .zc-span-8{grid-column:span 12}}
		.zc .zc-empty{color:var(--text-muted);font-size:var(--text-sm);margin:8px 0 0}
		.zc .zc-bars{display:flex;flex-direction:column;gap:7px}
		.zc .zc-row{display:grid;grid-template-columns:minmax(0,38%) 1fr auto;gap:10px;align-items:center;font-size:var(--text-sm)}
		.zc .zc-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.zc .zc-track{height:8px;border-radius:4px;background:var(--control-bg);overflow:hidden}
		.zc .zc-track i{display:block;height:100%;background:${BLUE};border-radius:4px}
		.zc .zc-val{font-variant-numeric:tabular-nums;color:var(--text-muted)}
		.zc .zc-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:var(--text-sm)}
		.zc .zc-table th{font-weight:500;color:var(--text-muted);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-color);vertical-align:bottom}
		.zc .zc-table td{padding:8px 10px;border-bottom:1px solid var(--border-color);overflow-wrap:anywhere;vertical-align:top}
		.zc .zc-table .zc-num{text-align:right;font-variant-numeric:tabular-nums}
		.zc .zc-table small{display:block;color:var(--text-muted);font-size:var(--text-xs)}
		.zc .zc-health{display:flex;flex-direction:column;gap:8px;font-size:var(--text-sm)}
		.zc .zc-hrow{display:flex;justify-content:space-between;gap:12px}
		.zc .zc-hrow span{color:var(--text-muted)}
		.zc .zc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
		.zc .zc-dot.on{background:${GREEN}}.zc .zc-dot.off{background:var(--gray-500, #98a1a9)}
		.zc .zc-bad{color:var(--red-500, #e24c4c)}
		.zc .zc-errs{display:flex;flex-direction:column;gap:6px;margin-top:2px}
		.zc .zc-errs a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
		.zc .zc-errs small{display:block;color:var(--text-muted);font-size:var(--text-xs)}
		.zc .zc-note{color:var(--text-muted);font-size:var(--text-xs);margin:10px 2px 0}
		.zc .zc-stamp{margin:12px 0 24px}
		`;
		$(`<style id="zc-style">${css}</style>`).appendTo(document.head);
	}
};