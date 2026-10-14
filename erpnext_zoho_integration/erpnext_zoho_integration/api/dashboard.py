"""Data for the Zoho Campaigns dashboard page.

Everything here comes from what the hourly sync already stored
(Campaign + Campaign Analytics + Campaign Recipient), so there are no live
Zoho calls and no cache to manage.

Place at: erpnext_zoho_integration/erpnext_zoho_integration/api/dashboard.py
"""
import frappe
from frappe.utils import add_days, get_datetime, nowdate

SYNC_METHOD = "erpnext_zoho_integration.erpnext_zoho_integration.api.sync.sync_all_campaigns"
SYNC_ROLES = ("System Manager", "Sales Manager", "Sales Master Manager")

# Campaign Analytics.metric label -> key used on the page
METRICS = {
	"Emails Sent": "sent",
	"Delivered": "delivered",
	"Opens": "opens",
	"Open Rate %": "open_rate",
	"Unique Clicks": "clicks",
	"Click Rate %": "click_rate",
	"Bounces": "bounces",
	"Bounce Rate %": "bounce_rate",
	"Unsubscribes": "unsubs",
	"Spam Complaints": "complaints",
}
RATE_KEYS = {"open_rate", "click_rate", "bounce_rate"}
COUNT_KEYS = ("sent", "delivered", "opens", "clicks", "bounces", "unsubs", "complaints")

# sync_campaign_recipients_data() asks Zoho for 100 recipients per action, no paging
RECIPIENT_FETCH_CAP = 100


def _num(v):
	try:
		return float(str(v).replace("%", "").strip())
	except (TypeError, ValueError):
		return 0.0


def _stamp(dt):
	return get_datetime(dt).strftime("%d %b %Y, %I:%M %p") if dt else None


@frappe.whitelist()
def get_dashboard(days=90):
	frappe.has_permission("Campaign", "read", throw=True)
	days = int(days)
	all_time = days <= 0  # 0 = "All time"
	since = get_datetime("1970-01-01") if all_time else get_datetime(add_days(nowdate(), -(min(days, 3650) - 1)))
	is_admin = "System Manager" in frappe.get_roles()

	# ---- campaigns synced from Zoho, sent inside the period.
	# Falls back to the creation date when Zoho's sent time didn't make it into the record,
	# instead of silently dropping those campaigns.
	campaigns = frappe.db.sql(
		"""select name, campaign_name, zoho_subject, zoho_sent_time,
			coalesce(zoho_sent_time, creation) as sent_at
		from `tabCampaign`
		where ifnull(zoho_campaign_id, '') != '' and coalesce(zoho_sent_time, creation) >= %(since)s
		order by sent_at desc""",
		{"since": since},
		as_dict=True,
	)
	names = tuple(c.name for c in campaigns)

	by_campaign = {n: {} for n in names}
	if names:
		for r in frappe.get_all(
			"Campaign Analytics",
			filters={"parenttype": "Campaign", "parent": ["in", names]},
			fields=["parent", "metric", "value", "percentage"],
			limit_page_length=0,
		):
			key = METRICS.get(r.metric)
			if not key:
				continue
			if key in RATE_KEYS:
				by_campaign[r.parent][key] = r.percentage if r.percentage is not None else _num(r.value)
			else:
				by_campaign[r.parent][key] = _num(r.value)

	rows = []
	totals = {k: 0 for k in COUNT_KEYS}
	weight = w_open = w_click = 0.0
	for c in campaigns:
		m = by_campaign[c.name]
		row = {k: m.get(k, 0) for k in METRICS.values()}
		row.update(
			name=c.name,
			title=c.campaign_name or c.name,
			subject=c.zoho_subject or "",
			sent_time=_stamp(c.sent_at),
			date=get_datetime(c.sent_at).strftime("%b %d").replace(" 0", " ") if c.sent_at else "",
		)
		rows.append(row)
		for k in COUNT_KEYS:
			totals[k] += row[k]
		w = row["delivered"] or row["sent"]  # weight rates by audience size
		weight += w
		w_open += row["open_rate"] * w
		w_click += row["click_rate"] * w

	totals["campaigns"] = len(rows)
	totals["open_rate"] = round(w_open / weight, 2) if weight else 0
	totals["click_rate"] = round(w_click / weight, 2) if weight else 0

	asc = list(reversed(rows))
	trend = {
		"labels": [r["title"] for r in asc],
		"dates": [r["date"] for r in asc],
		"open_rate": [round(r["open_rate"], 2) for r in asc],
		"click_rate": [round(r["click_rate"], 2) for r in asc],
	}

	# ---- recipient-level cards (built from the recipients the sync stored)
	actions = countries = cities = contacts = []
	capped = 0
	if names:
		p = {"n": names}
		actions = frappe.db.sql(
			"""select action_type as label, count(*) as value
			from `tabCampaign Recipient` where campaign in %(n)s
			group by action_type order by value desc""",
			p, as_dict=True,
		)
		countries = frappe.db.sql(
			"""select country as label, count(distinct email) as value
			from `tabCampaign Recipient`
			where campaign in %(n)s and action_type in ('Opened', 'Clicked') and ifnull(country, '') != ''
			group by country order by value desc limit 8""",
			p, as_dict=True,
		)
		cities = frappe.db.sql(
			"""select city as label, count(distinct email) as value
			from `tabCampaign Recipient`
			where campaign in %(n)s and action_type in ('Opened', 'Clicked') and ifnull(city, '') != ''
			group by city order by value desc limit 8""",
			p, as_dict=True,
		)
		contacts = frappe.db.sql(
			"""select email, max(full_name) as full_name, max(company_name) as company_name,
				max(contact) as contact,
				sum(case when action_type = 'Opened' then 1 else 0 end) as opened,
				sum(case when action_type = 'Clicked' then 1 else 0 end) as clicked
			from `tabCampaign Recipient`
			where campaign in %(n)s and action_type in ('Opened', 'Clicked')
			group by email order by clicked desc, opened desc limit 10""",
			p, as_dict=True,
		)
		for c in contacts:
			c["opened"], c["clicked"] = int(c["opened"] or 0), int(c["clicked"] or 0)

		capped = len(
			{
				r.campaign
				for r in frappe.db.sql(
					"""select campaign, action_type, count(*) as c from `tabCampaign Recipient`
					where campaign in %(n)s group by campaign, action_type having c >= %(cap)s""",
					{"n": names, "cap": RECIPIENT_FETCH_CAP}, as_dict=True,
				)
			}
		)

	synced = frappe.db.sql(
		"""select count(*), max(coalesce(zoho_sent_time, creation)),
			sum(case when zoho_sent_time is null then 1 else 0 end)
		from `tabCampaign` where ifnull(zoho_campaign_id, '') != ''"""
	)[0]

	return {
		"synced": {
			"total": int(synced[0] or 0),
			"latest": _stamp(synced[1]),
			"missing_sent_time": int(synced[2] or 0),
		},
		"totals": totals,
		"rows": rows,
		"trend": trend,
		"actions": actions,
		"countries": countries,
		"cities": cities,
		"contacts": contacts,
		"capped_campaigns": capped,
		"recipient_cap": RECIPIENT_FETCH_CAP,
		"health": _health(since, is_admin),
	}


def _health(since, is_admin):
	last = frappe.db.sql(
		"select max(last_synced) from `tabCampaign` where ifnull(zoho_campaign_id, '') != ''"
	)[0][0]
	health = {
		"is_active": 0,
		"last_synced": _stamp(last),
		"token_expiry": None,
		"errors_visible": bool(is_admin),
		"errors": [],
		"error_count": 0,
	}
	try:
		settings = frappe.get_single("Zoho Settings")
		health["is_active"] = int(settings.is_active or 0)
		if is_admin:
			health["token_expiry"] = _stamp(settings.token_expiry)
	except Exception:
		pass

	if is_admin:
		try:
			kw = {
				"filters": {"creation": [">=", since]},
				"or_filters": [["method", "like", "%Sync%Error%"], ["method", "like", "%Zoho%Error%"]],
			}
			health["error_count"] = len(
				frappe.get_all("Error Log", pluck="name", limit_page_length=500, **kw)
			)
			health["errors"] = [
				{"name": e.name, "title": e.method, "when": _stamp(e.creation)}
				for e in frappe.get_all(
					"Error Log", fields=["name", "method", "creation"],
					order_by="creation desc", limit_page_length=5, **kw,
				)
			]
		except Exception:
			pass
	return health


@frappe.whitelist()
def sync_now():
	"""Run the existing sync in a background worker.

	A full sync makes ~7 Zoho calls per campaign, which can outlive a web request,
	so the page queues it instead of calling sync_all_campaigns() inline.
	"""
	frappe.only_for(SYNC_ROLES)
	frappe.enqueue(SYNC_METHOD, queue="long", timeout=1800)
	return {"queued": True}