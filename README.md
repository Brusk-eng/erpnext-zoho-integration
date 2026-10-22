# Zoho Campaigns Integration for ERPNext

App: `erpnext_zoho_integration` · Version 0.0.1 · Author: Yanky · MIT licence · Written from the repository source, October 2026

## About this document

This document has two parts.

- **Part 1: Technical documentation** is for developers and administrators. It covers architecture, data model, authentication, the sync engine, the API, security, known issues and a troubleshooting runbook.
- **Part 2: User manual** is for the marketing and sales people who read the results, and for the administrator who does the one-time setup.

Every technical statement was checked against the source code, not only the README. Where the README and the code disagree, the code wins, and the difference is recorded in the Known issues section. Items marked **(added)** were built after the original repository and are not in the version that was analysed.

# Part 1: Technical documentation

## 1. Overview

The app pulls email-campaign results from **Zoho Campaigns** into ERPNext. The flow is one-way, from Zoho to ERPNext. For every campaign that Zoho reports as *Sent*, the app:

1. creates or updates a standard ERPNext **Campaign** record carrying the Zoho metadata,
2. stores Zoho's performance metrics (opens, clicks, bounces and so on) as rows in a child table,
3. stores who opened, clicked, bounced, unsubscribed or complained as **Campaign Recipient** records, and
4. links each recipient to an ERPNext **Contact**, creating the Contact if none exists.

It is a read-only integration. The OAuth scopes request contact create and update rights, but no code path writes anything back to Zoho.

**Capabilities**

- OAuth 2.0 authorization-code flow with automatic token refresh.
- Hourly scheduled sync, plus manual sync for all campaigns (Zoho Settings) or one campaign (Campaign form).
- Campaign form dashboard with clickable metric cards.
- *Campaign Performance* script report.
- **(added)** *Zoho Campaigns* dashboard page with KPIs, charts, tables and a sync-health card.

**Environment.** Frappe/ERPNext v15 is the reference version (`pyproject.toml` requires Python 3.10 or newer and mentions `frappe~=15.0.0`). The README says v14+ and Python 3.7+; treat `pyproject.toml` as authoritative. The Zoho data centre is **India (`.in`) and is hard-coded** (see section 5).

## 2. Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| OAuth | `api/oauth.py` | Redirect to Zoho consent, exchange code for tokens, refresh the access token |
| API wrapper | `api/campaigns.py` | `get_valid_token()`, `make_api_call()`, and one helper per Zoho endpoint |
| Sync | `api/sync.py` | Maps Zoho data to Campaign, Campaign Analytics, Campaign Recipient and Contact |
| Storage | `doctype/zoho_settings`, `doctype/campaign_recipient`, `doctype/campaign_analytics`, `custom/campaign.json`, `custom/contact.json` | DocTypes and custom fields |
| UI | `doctype/zoho_settings/zoho_settings.js`, `public/js/campaign.js`, `report/campaign_performance` | Buttons, form dashboard, report |
| Scheduler | `hooks.py` | Registers the hourly job |
| **(added)** Dashboard | `api/dashboard.py`, `page/zoho_campaigns_dashboard/` | Dashboard data endpoint and page |

All paths are relative to `erpnext_zoho_integration/erpnext_zoho_integration/` unless they start with `hooks.py` or `public/`, which live one level up.

**Data flow**

```
Scheduler (hourly)  or  Sync buttons
  -> sync_all_campaigns()  /  sync_campaign_by_name()
       -> get_recent_campaigns(limit=50)        GET   recentcampaigns
       -> for each campaign with status "Sent": sync_single_campaign()
            -> Campaign (create or update, zoho_* custom fields)
            -> get_campaign_report()            GET   campaignreports
            -> Campaign Analytics rows (cleared and rebuilt)
            -> 6 x get_campaign_recipients()    POST  getcampaignrecipientsdata
            -> Campaign Recipient (upsert) and Contact (find or create)
```

Every HTTP call to Zoho goes through `make_api_call()`, which attaches a bearer token obtained from `get_valid_token()`.

## 3. Repository layout

```
erpnext_zoho_integration/
  hooks.py                         doctype_js + hourly scheduler event
  modules.txt                      "Erpnext Zoho Integration"
  patches.txt                      empty
  public/js/campaign.js            Campaign form: Sync button and dashboard
  erpnext_zoho_integration/
    api/
      oauth.py  campaigns.py  sync.py  custom_fields.py
      dashboard.py                 (added)
    custom/campaign.json  contact.json     custom fields (synced on migrate)
    doctype/zoho_settings/  campaign_recipient/  campaign_analytics/
    report/campaign_performance/
    page/zoho_campaigns_dashboard/ (added)
```

## 4. Data model

### 4.1 Campaign (standard DocType, extended)

The custom fields are shipped in `custom/campaign.json` and applied on `bench migrate`. They sit in a collapsible section called *Zoho Campaign Data*, inserted after the Description field.

| Field | Type | Zoho source and notes |
| --- | --- | --- |
| `zoho_campaign_id` | Data, unique, read-only | `campaignId`. The key used to find an existing Campaign |
| `zoho_campaign_key` | Data, read-only | `campaign_key`. Required for report and recipient calls |
| `zoho_subject` | Data | `subject` |
| `zoho_from_email` | Data | `from_email` |
| `zoho_reply_to` | Data | `reply_to` |
| `zoho_sent_time` | Datetime, read-only | `sent_time`, a millisecond epoch converted on import |
| `zoho_campaign_status` | Data | `campaign_status` |
| `zoho_campaign_type` | Data | `campaigntype` |
| `zoho_preview_url` | Small Text | `campaign_preview`, with `https://` added if missing |
| `campaign_analytics` | Table (Campaign Analytics) | Rebuilt on every sync |
| `last_synced` | Datetime | Set each time the campaign is synced |

New campaigns get the naming series `SAL-CAM-.YYYY.-` and `campaign_name` from Zoho.

### 4.2 Campaign Analytics (child table)

| Field | Type | Notes |
| --- | --- | --- |
| `metric` | Data, required | Label such as `Opens` or `Open Rate %` |
| `value` | Data | The raw Zoho value stored as text |
| `percentage` | Percent | Filled only for rate metrics |

### 4.3 Campaign Recipient

One row per *(campaign, email, action type)*. Naming rule: `format:{contact}-{email}-{##}`. If the Contact link is empty the name starts with a dash.

| Field | Type | Filled by the sync? |
| --- | --- | --- |
| `campaign` | Link, required | Yes |
| `contact` | Link | Yes. `before_save` also links by email if empty |
| `email` | Data, required | Yes, from `contactemailaddress` |
| `zoho_contact_id` | Data, read-only | Yes, from `contactid` |
| `action_type` | Select, required | Yes. Options: Sent, Opened, Clicked, Hard Bounced, Soft Bounced, Unsubscribed, Complaint. **Sent is never written** |
| `action_date`, `sent_time` | Datetime | Yes, **both from Zoho's `sentdate`**. `action_date` is therefore the send date, not the moment of the open or click |
| `open_count` | Int | No, never set |
| `location` | Data | No, never set |
| `country`, `city`, `state` | Data | Yes |
| `is_spam`, `is_optout` | Check | No, never set |
| `contact_status` | Data | Yes, from `contactstatus` |
| `open_reports` | Long Text | Yes, for Opened rows only (JSON) |
| `full_name`, `company_name`, `job_title` | Data | Yes |

### 4.4 Contact (standard DocType, extended)

`custom/contact.json` adds a *Zoho Data* section with `zoho_contact_id`, `zoho_status` and `zoho_last_synced`. It also ships an unrelated `is_billing_contact` checkbox that the sync does not use.

### 4.5 Zoho Settings (single DocType)

| Field | Type | Notes |
| --- | --- | --- |
| `client_id` | Data | From the Zoho API Console |
| `client_secret` | Password | Encrypted by Frappe |
| `redirect_uri` | Data | Must match the Zoho console exactly |
| `code` | Data | Temporary authorization code pasted by the admin |
| `access_token` | Password, read-only | Written by the token exchange or refresh |
| `refresh_token` | Password, read-only | Written once, at the code exchange |
| `token_expiry` | Datetime, read-only | Now plus `expires_in` |
| `api_domain` | Data, read-only | Stored from the token response but **not used** by any API call |
| `is_active` | Check | Set to 1 after a successful code exchange. Gates every API call |

### 4.6 Permissions

- **Zoho Settings** and **Campaign Recipient**: System Manager only (read, write, create, delete).
- **Campaign Analytics** is a child table and follows Campaign.
- **Campaign Performance** report roles: Sales User, Sales Manager, Sales Master Manager, Manager Sales, HR Manager, System Manager.

Because only System Manager can open Campaign Recipient, a Sales User who clicks a metric card on the Campaign form lands on a list they are not allowed to see. Grant a role permission on Campaign Recipient if that workflow should work for them.

## 5. Authentication

**Flow**

1. The admin saves *Client ID*, *Client Secret* and *Redirect URI* in Zoho Settings.
2. **Authorize with Zoho** sends the browser to `https://accounts.zoho.in/oauth/v2/auth` with `response_type=code`, `access_type=offline` and `prompt=consent`.
3. After consent Zoho redirects to the Redirect URI. The `callback` method simply returns the `code`, so it is displayed in the browser.
4. The admin pastes the code into the **Code** field and saves, then clicks **Fetch Tokens**. `fetch_tokens(code)` posts to `https://accounts.zoho.in/oauth/v2/token`, stores both tokens and the expiry, and sets `is_active = 1`.
5. Zoho authorization codes are short-lived, so this step must follow quickly.

**Requested scopes:** `ZohoCampaigns.campaign.READ`, `ZohoCampaigns.contact.CREATE`, `ZohoCampaigns.contact.READ`, `ZohoCampaigns.contact.UPDATE`. Only the two READ scopes are exercised by the code.

**Token lifecycle**

- `get_valid_token()` throws *Zoho integration is not active* if `is_active` is 0.
- If `token_expiry - 5 minutes` has passed, it calls `refresh_access_token()`. The refresh token itself never changes.
- If an API call returns **401**, `make_api_call()` refreshes once and retries once.
- The refresh posts `grant_type=refresh_token` to the same token URL.

**Hard-coded data centre.** The auth URL, token URL and API base (`https://campaigns.zoho.in/api/v1.1/`) are literals. Accounts on `.com`, `.eu` or other Zoho data centres will not work without code changes.

## 6. Sync engine

### 6.1 Triggers

| Trigger | Entry point | Scope |
| --- | --- | --- |
| Scheduler, hourly | `sync_all_campaigns()` | Up to 50 most recent campaigns |
| Zoho Settings, **Sync All Campaigns** | `sync_all_campaigns()` | Same, run inside the web request |
| Campaign form, **Sync from Zoho** | `sync_campaign_by_name(name)` | Analytics and recipients of one campaign |
| **(added)** Dashboard, **Sync Now** | `dashboard.sync_now()` | Queues `sync_all_campaigns()` on the long queue (1800 s timeout) |

### 6.2 Algorithm

1. `get_recent_campaigns(limit=50)` calls `recentcampaigns` with `range=50`.
2. Campaigns whose `campaign_status` is not `Sent` are skipped.
3. `sync_single_campaign()` skips records without a `campaign_key`. Otherwise it finds the Campaign by `zoho_campaign_id` (or creates it), maps the metadata fields, sets `last_synced` and saves.
4. `sync_campaign_analytics()` fetches `campaignreports`. If the `campaign-reports` section is empty it returns **and recipients are not synced**. Otherwise it clears the child table, appends one row per metric Zoho returned, and saves.
5. `sync_campaign_recipients_data()` loops over six actions (6.5) and fetches **the first 100** recipients for each. It commits after each action.
6. `sync_recipient()` skips rows without an email, finds or creates the Contact, upserts the Campaign Recipient and saves.
7. `sync_all_campaigns()` commits and returns `{success, synced_count, total_campaigns, errors[]}`.

`sync_campaign_by_name()` does steps 4 to 6 only. It does **not** refresh the campaign's metadata (subject, sent time, status).

### 6.3 Zoho endpoints used

| Helper | Method and endpoint | Notes |
| --- | --- | --- |
| `get_recent_campaigns` | GET `recentcampaigns` | Response keys `recent_campaigns`, `total_record_count` |
| `get_campaign_report` | GET `campaignreports` | Sections `campaign-details`, `campaign-reports`, `campaign-reach`, and `campaign-by-loaction` (Zoho's own spelling) |
| `get_campaign_recipients` | POST `getcampaignrecipientsdata` | Params `action`, `fromindex`, `range`. Reads the `list_of_details` key |

A Zoho response whose message contains *no contacts* is treated as success with an empty list.

### 6.4 Metric mapping

Stored as Campaign Analytics rows. The `percentage` column is set when the Zoho key contains `percent` or `rate`.

| Zoho key | Label | Zoho key | Label |
| --- | --- | --- | --- |
| `emails_sent_count` | Emails Sent | `unsub_count` | Unsubscribes |
| `delivered_count` | Delivered | `unsubscribe_percent` | Unsubscribe Rate % |
| `delivered_percent` | Delivered % | `complaints_count` | Spam Complaints |
| `opens_count` | Opens | `complaints_percent` | Spam Rate % |
| `open_percent` | Open Rate % | `unopened` | Unopened |
| `unique_clicks_count` | Unique Clicks | `unopened_percent` | Unopened % |
| `unique_clicked_percent` | Click Rate % | `clicksperopenrate` | Click-to-Open Rate |
| `bounces_count` | Bounces | `forwards_count` | Forwards |
| `bounce_percent` | Bounce Rate % | `hardbounce_count` | Hard Bounces |
| `softbounce_count` | Soft Bounces |  |  |

### 6.5 Recipient actions

| Zoho action key | Stored `action_type` |
| --- | --- |
| `openedcontacts` | Opened |
| `clickedcontacts` | Clicked |
| `senthardbounce` | Hard Bounced |
| `sentsoftbounce` | Soft Bounced |
| `optoutcontacts` | Unsubscribed |
| `spamcontacts` | Complaint |

So one campaign costs **7 Zoho API calls** (1 report and 6 recipient lists), plus the single `recentcampaigns` call per run.

### 6.6 Contact matching and deduplication

- **Recipient rows** are matched on *(campaign, email, action\_type)*. A match is updated, otherwise a row is inserted. Rows are never deleted.
- **Contacts** are matched first on `zoho_contact_id`, then on an exact `Contact Email.email_id`. If neither matches, a new Contact is created with the Zoho first name (or `Unknown`), last name, primary email, and phone when `phone` or `mobile` is present.
- `update_contact_from_zoho()` runs for **every recipient row**, new or existing. It writes the Zoho id, status and sync time, and fills company and designation only when they are blank. Each call saves the Contact, so large audiences produce many writes.

### 6.7 Error handling and Error Log titles

Failures are written to **Error Log**. Filter on these titles when diagnosing.

| Title | Raised in |
| --- | --- |
| Zoho OAuth Error, Zoho Token Refresh Error | `oauth.py` |
| Zoho Get Recent Campaigns Error | `get_recent_campaigns` |
| Zoho Get Campaign Report Error | `get_campaign_report` |
| Zoho Get Campaign Recipients Error | `get_campaign_recipients` |
| Campaign Sync Error: *campaign name* | One campaign failed inside `sync_all_campaigns` |
| Campaign Analytics Sync Error: *Campaign doc name* | Report fetch or analytics save failed |
| Recipient Sync Error: *Campaign doc name* | One recipient action failed (the loop continues) |
| Sync All Campaigns Error | The whole run failed, usually the `recentcampaigns` call |

A per-campaign failure does not stop the run. `sync_all_campaigns()` still returns `success: true` with the failures listed in `errors`.

## 7. API reference

Methods are listed relative to the `erpnext_zoho_integration.erpnext_zoho_integration.api` package. "Login" means any authenticated user, because the methods are whitelisted without a role check (see section 11).

| Method | Access | Arguments | Returns |
| --- | --- | --- | --- |
| `oauth.authorize()` | Guest | none | Redirect to the Zoho consent screen |
| `oauth.callback(code)` | Guest | `code` | The code, displayed in the browser |
| `oauth.fetch_tokens(code)` | Guest | `code` | Zoho token response. Saves tokens and sets `is_active = 1` |
| `oauth.refresh_access_token()` | Guest | none | New access token string |
| `campaigns.get_recent_campaigns(limit=20)` | Login | `limit` | `{campaigns, total_count, fetched_count}` |
| `campaigns.get_campaign_report(campaign_key)` | Login | `campaign_key` | `{campaign_details, campaign_reports, campaign_reach, campaign_by_location}` |
| `campaigns.get_campaign_recipients(campaign_key, action, fromindex=1, range_val=20)` | Login | see 6.5 | `{recipients, action, total_fetched}` |
| `campaigns.sync_campaign_data(campaign_key)` | Login | `campaign_key` | Report plus opened, clicked, bounced and unsubscribed lists. Not used by the sync, and it has no spam list |
| `sync.sync_all_campaigns()` | Login | none | `{success, synced_count, total_campaigns, errors[]}` |
| `sync.sync_campaign_by_name(campaign_name)` | Login | ERPNext Campaign name | `{success, message}`. Throws if the campaign has no `zoho_campaign_key` |
| **(added)** `dashboard.get_dashboard(days=90)` | Campaign read permission | `days`, where `0` means all time | Dashboard payload (section 9) |
| **(added)** `dashboard.sync_now()` | System Manager, Sales Manager, Sales Master Manager | none | `{queued: true}` |

Internal helpers that are not whitelisted: `get_valid_token()`, `make_api_call(endpoint, method="GET", params=None, data=None)`, `sync_single_campaign()`, `sync_campaign_analytics()`, `sync_campaign_recipients_data()`, `sync_recipient()`, `find_or_create_contact()` and `update_contact_from_zoho()`.

**Calling from the bench console**

```python
from erpnext_zoho_integration.erpnext_zoho_integration.api.campaigns import get_recent_campaigns
get_recent_campaigns(limit=5)
```

**Calling from the browser**

```javascript
frappe.call({
  method: "erpnext_zoho_integration.erpnext_zoho_integration.api.sync.sync_campaign_by_name",
  args: { campaign_name: "SAL-CAM-2025-00001" },
});
```

## 8. User interface components

### 8.1 Zoho Settings form

| Button | Visible when | Action |
| --- | --- | --- |
| Authorize with Zoho | Integration not active | Redirects to `oauth.authorize` |
| Fetch Tokens | Not active and *Code* is filled | Calls `fetch_tokens` |
| Test Connection | Active | Fetches 5 campaigns and shows how many were found |
| View Campaigns | Active | Lists recent campaigns in a dialog |
| Refresh Token | Active | Calls `refresh_access_token`, then reloads the form |
| Sync All Campaigns | Active | Runs `sync_all_campaigns` in the web request and reports *Synced X out of Y* with any per-campaign errors |

Because *Sync All Campaigns* runs inside the web request, a large account can hit a gateway timeout. The dashboard's **Sync Now** avoids this by queueing the job.

### 8.2 Campaign form

The additions only appear when the Campaign has a `zoho_campaign_key`.

- **Sync from Zoho** button calls `sync_campaign_by_name` and reloads the form.
- A metric dashboard is inserted above the Analytics table half a second to a second after load. Rows are grouped by keyword into *Engagement Metrics* (up to six cards: opens, clicks, bounces, unsubscribes, complaints) and *Campaign Stats* (up to six cards: sent, delivered, rates). If nothing matches, the first six rows are shown.
- Clicking an engagement card opens the Campaign Recipient list filtered by that campaign and action type.

### 8.3 Campaign Recipient list

Indicator colours: Opened is green, Clicked is blue, Unsubscribed and Complaint are red. Everything else is grey, which includes Hard Bounced and Soft Bounced (see Known issues).

### 8.4 Campaign Performance report

A script report on Campaign with one row per Zoho-linked Campaign. Columns: Campaign (the document name), Sent Time, Sent, Opens, Open %, Clicks, Click %, Bounces, Unsubs. It reads the Campaign Analytics rows of each campaign with one query per campaign. Its only filter, *Printed On*, is read-only and filters nothing, and there is no date range.

## 9. (added) Zoho Campaigns dashboard page

**Route:** `/app/zoho-campaigns-dashboard`. **Roles:** Sales User, Sales Manager, Sales Master Manager, System Manager.

**Files**

- `api/dashboard.py` provides `get_dashboard(days)` and `sync_now()`.
- `page/zoho_campaigns_dashboard/zoho_campaigns_dashboard.json` is the Page definition.
- `page/zoho_campaigns_dashboard/zoho_campaigns_dashboard.js` renders the page.
- Two empty `__init__.py` files.

**Design.** The page reads only data the sync already stored (Campaign, Campaign Analytics, Campaign Recipient). It makes no Zoho calls and needs no cache. The toolbar has **Period** (30 Days, 90 Days as default, 180 Days, 1 Year, All time), **Refresh** and **Sync Now**.

| Card | How it is computed |
| --- | --- |
| KPI cards | Campaigns, emails sent, bounces and unsubscribes are sums of Campaign Analytics. Average open and click rates are weighted by delivered count (or emails sent when delivered is 0) |
| Open and click rate by campaign | Bars when there are 7 campaigns or fewer, otherwise a line by date |
| Recipient actions | Count of Campaign Recipient rows per action type |
| Campaign performance | One row per campaign, linked to the Campaign form |
| Top countries and cities | Distinct emails that opened or clicked, top 8 |
| Most engaged contacts | Top 10 by campaigns clicked, then campaigns opened. Linked to Contact |
| Sync health | Active flag and last sync for everyone. Token expiry, error count and the five latest errors for System Managers only |

**Which campaigns are in the period.** A campaign counts if `coalesce(zoho_sent_time, creation)` falls inside the period. The creation date is only a fallback for records whose sent time was never stored, and the page says how many such campaigns there are.

**Payload keys of `get_dashboard`:** `synced`, `totals`, `rows`, `trend`, `actions`, `countries`, `cities`, `contacts`, `capped_campaigns`, `recipient_cap`, `health`.

**Sync Now** enqueues `sync_all_campaigns` on the `long` queue with an 1800 second timeout and returns immediately. Use Refresh after a minute or two.

**Installation.** Copy the files into the app, then run `bench --site <site> migrate` and `bench restart`. Migrate registers the Page.

## 10. Scheduler and performance

**Schedule.** `hooks.py` registers `sync_all_campaigns` under the `hourly` event. The scheduler must be enabled for the site and a worker must be running.

**Queue and timeout.** Frappe runs `hourly` jobs on the default queue, which has a short timeout (about five minutes unless your bench changes it). A large sync can be killed part-way. The `hourly_long` event runs on the long queue and is the safer registration for this job.

**Cost model**

- 1 call to `recentcampaigns` per run, then 7 Zoho calls per Sent campaign.
- Up to 600 recipient rows per campaign per run (6 actions times 100).
- Per recipient row: a Contact lookup, one or two Contact saves, an existence check and a Campaign Recipient save.
- All 50 recent campaigns are re-synced every hour, even ones that finished long ago.
- There is no back-off or rate-limit handling. A 429 from Zoho surfaces as an ordinary error.

The README quotes two to five minutes for 50 campaigns. Measure on your own data before relying on that.

## 11. Security and privacy

- **Guest-callable endpoints.** `authorize`, `callback`, `fetch_tokens` and `refresh_access_token` are whitelisted with `allow_guest=True`. Only `authorize` and `callback` need that for the OAuth redirect. `fetch_tokens` and `refresh_access_token` should require a System Manager.
- **No role checks on data endpoints.** `frappe.whitelist()` only requires a login. Any desk user can call `sync_all_campaigns`, or the raw report and recipient fetchers, which return names, emails, companies and locations. Add `frappe.only_for("System Manager")` or a permission check.
- **Secrets.** `client_secret`, `access_token` and `refresh_token` are Password fields, encrypted with the site's `encryption_key`. Back that key up with the site, and never log token values.
- **Unused scopes.** Contact CREATE and UPDATE are requested but unused. Remove them for least privilege.
- **Personal data.** Campaign Recipient stores email, name, company, job title and location. The sync reads Zoho's `rtbf` (right to be forgotten) flag but has nowhere to store it, so erasure requests made in Zoho are not reflected in ERPNext.
- **Permission bypass.** All writes use `ignore_permissions=True`. That is appropriate for a system sync, provided only trusted triggers can reach it, which ties back to the second point.

## 12. Known issues and limitations

Each item was verified in the code. Fixes are suggestions, not applied changes.

| # | Issue | Impact | Suggested fix |
| --- | --- | --- | --- |
| 1 | Recipients are fetched with `range_val=100` and `fromindex=1`, with no paging | Recipient lists, geography and contacts are incomplete for larger sends. Campaign totals are unaffected | Loop on `fromindex` until a page returns fewer than 100 |
| 2 | The sync sets `click_count`, `clicked_links`, `click_reports`, `url_clicks` and `is_rtbf`, which do not exist on Campaign Recipient | Frappe drops them silently, so there is no click detail and no erasure flag | Add the fields to the DocType and migrate |
| 3 | `open_count`, `location`, `is_spam` and `is_optout` are never set. The Sent action is never synced | Empty columns and an unused option | Populate them or remove them |
| 4 | `action_date` is filled from `sentdate` | The field holds the send date, not the open or click time | Use the timestamps inside the open and click reports |
| 5 | Auth, token and API URLs are hard-coded to `.in`. `api_domain` is stored but unused | Other Zoho data centres fail | Derive the URLs from a setting |
| 6 | `zoho_sent_time = get_datetime(int(ms) / 1000)` runs inside `except (ValueError, TypeError): pass` | If the conversion fails, the field stays empty with no log, which hides campaigns from date-filtered views | Convert from a UTC epoch with `datetime.fromtimestamp(..., tz=timezone.utc)` and `convert_utc_to_system_timezone`, and log failures |
| 7 | `oauth.py` stores expiry with `datetime.now()` but `get_valid_token()` compares with `now_datetime()` | If the server clock timezone differs from the site timezone, refreshes happen too early or too late. Repeated refreshes can hit Zoho's rate limit | Use `frappe.utils.now_datetime()` and `add_to_date` in `oauth.py` |
| 8 | The hourly job uses the default queue | Possible timeout on large syncs | Register under `hourly_long` |
| 9 | `sync_all_campaigns` returns `success: true` even when every campaign failed | The scheduler looks healthy while nothing syncs | Raise or log a summary when `errors` is not empty |
| 10 | `float(value)` is applied to rate metrics | A non-numeric value such as `N/A` or `12%` fails the whole campaign's analytics | Strip `%` and parse defensively |
| 11 | The Campaign form card and the list indicator use `Bounced`, but stored values are `Hard Bounced` and `Soft Bounced` | The Bounced card opens an empty list, and bounce rows are grey | Use the real values, or map both |
| 12 | `api/custom_fields.py` has an `execute()` patch but is not listed in `patches.txt` | Dead code. The real fields come from `custom/*.json` | Delete it or register it |
| 13 | The Campaign Performance report shows the document name, has a meaningless filter, and queries once per campaign | Confusing and slow on large data | Show `campaign_name`, add a date filter, use one joined query |
| 14 | `sync_campaign_by_name` skips `sync_single_campaign` | Subject, status and sent time are not refreshed by the form button | Call `sync_single_campaign` first |
| 15 | Every recipient row saves a Contact, and unknown recipients create new Contacts | Heavy writes and Contact clutter | Save only when a field changed, and make contact creation optional |
| 16 | An empty `campaign-reports` section ends the campaign's sync early | Recipients are silently skipped | Log it and continue to recipients |
| 17 | README differences | The README describes bi-directional mapping (the code is one-way), lists the click fields and Sent action as synced, shows percentages on count rows such as Delivered (only rate rows carry one), and cites Python 3.7+ (the project requires 3.10+) | Update the README |

## 13. Installation and deployment

**Prerequisites**

- A bench running Frappe/ERPNext v15 with the scheduler enabled and at least one worker running.
- A site reachable over HTTPS from the administrator's browser, because Zoho redirects the browser back to it.
- A Zoho Campaigns account on the India data centre (`.in`).
- Permission to create a client in the Zoho API Console (`api-console.zoho.in`).

**Steps**

1. Install the app. The README's clone URL is a placeholder, so use the real repository:

   ```bash
   cd ~/frappe-bench
   bench get-app https://github.com/Yaiphalemba/erpnext-zoho-integration.git
   bench --site <site> install-app erpnext_zoho_integration
   bench --site <site> migrate
   ```

   Migrate applies the Campaign and Contact custom fields from `custom/*.json`.
2. In the Zoho API Console create a **Server-based Application**. Set the redirect URI to `https://<your-site>/api/method/erpnext_zoho_integration.erpnext_zoho_integration.api.oauth.callback` and copy the Client ID and Client Secret.
3. Open **Zoho Settings** in ERPNext, enter Client ID, Client Secret and the same Redirect URI, and save.
4. Click **Authorize with Zoho** and approve the four scopes. Copy the code shown on the callback page.
5. Paste it into **Code**, save, and click **Fetch Tokens** straight away.
6. Click **Test Connection**, then **Sync All Campaigns** (or use **Sync Now** on the dashboard).
7. Confirm the scheduler is on with `bench --site <site> enable-scheduler`, and that workers run under supervisor or `bench start`.
8. **(added)** To install the dashboard, copy `api/dashboard.py` and the `page/zoho_campaigns_dashboard/` folder into the app, run `bench --site <site> migrate`, then `bench restart`.

**Upgrading.** Pull the new code, run `bench --site <site> migrate`, and run `bench build --app erpnext_zoho_integration` if JavaScript under `public/` changed.

**Production notes.** Back up the site's `encryption_key` along with the database, otherwise the stored tokens and secret cannot be decrypted after a restore. Consider registering the job under `hourly_long` (section 10).

## 14. Operations and troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| *Zoho integration is not active* | `is_active` is 0 | Authorize and fetch tokens again |
| *No refresh token available* | Tokens were cleared or never fetched | Re-authorize |
| Fetch Tokens fails with an `invalid_code` style error | The code expired or was used, or the redirect URI differs from the Zoho console | Authorize again, paste the new code immediately, and compare the redirect URI character by character |
| Hourly *Zoho Get Recent Campaigns Error* followed by *Sync All Campaigns Error* | Access token expired and refresh failed, wrong data centre, a network or DNS problem on the server, or a Zoho error | Open the Error Log entry for the real message. Check *Token Expiry* in Zoho Settings, click **Refresh Token**, and test the server's network. Also check known issue 7 (clock timezone) |
| Campaigns exist but the dashboard is empty | The period is too short, or `zoho_sent_time` is empty | Select **All time**. Run the console query below to see the stored sent times |
| Campaign exists but has no analytics | Zoho's `campaign-reports` section was empty, or the analytics save failed | Wait a few minutes and sync again. Look for *Campaign Analytics Sync Error* |
| Recipient lists look short | The 100-per-action cap (known issue 1), or Zoho returned *no contacts* | Compare with Zoho's own report. Fix the paging if full lists are needed |
| The Bounced card opens an empty list | Known issue 11 | Filter the list manually on Hard Bounced or Soft Bounced |
| A recipient is not linked to a Contact | The email does not exactly match a *Contact Email* | Correct the email in ERPNext, or link the Contact by hand |
| Many Contacts named *Unknown* | Zoho recipients without a first name | Review and merge them |
| *Sync All Campaigns* spins and then fails | The web request timed out | Use **Sync Now** on the dashboard, or run the sync from the console |
| Data stops updating | Scheduler disabled or no worker | Run `bench --site <site> doctor`, then enable the scheduler and restart workers |

**Console snippets** (`bench --site <site> console`)

```python
# Newest synced campaigns, and whether a sent time was stored
frappe.db.sql("""select name, zoho_sent_time, last_synced from `tabCampaign`
  where ifnull(zoho_campaign_id, '') != '' order by last_synced desc limit 5""", as_dict=1)

# Run one full sync and read the result
from erpnext_zoho_integration.erpnext_zoho_integration.api.sync import sync_all_campaigns
sync_all_campaigns()

# Check that a token exists (prints the token, so do not share the output)
frappe.get_single("Zoho Settings").get_password("access_token")
```

## 15. Developer guide

**Add a metric.** Add the Zoho key and label to `metric_mapping` in `sync_campaign_analytics()`. If it is a rate, keep `percent` or `rate` in the key so the `percentage` column is filled. To show it on the dashboard page, add the label to `METRICS` in `dashboard.py`.

**Add a recipient action.** Add the Zoho action key to `action_mapping`, add the label to the `action_type` Select options on Campaign Recipient, and add it to the list indicator map.

**Store another Zoho field on Campaign.** Add a custom field (in developer mode, or in `custom/campaign.json`), run `bench --site <site> migrate`, and map it in `sync_single_campaign()`.

**Fetch every recipient, not just the first 100.** A starting point for known issue 1:

```python
def fetch_all_recipients(campaign_key, action_key, page=100):
    start, rows = 1, []
    while True:
        batch = get_campaign_recipients(
            campaign_key, action_key, fromindex=start, range_val=page
        )["recipients"]
        rows += batch
        if len(batch) < page:
            return rows
        start += page
```

Use it in `sync_campaign_recipients_data()` in place of the single `get_campaign_recipients(..., range_val=100)` call, and move the Contact work to a background job if audiences are large.

**Tests.** The generated test files are empty stubs. The most valuable first tests mock `make_api_call` and assert that `sync_single_campaign` upserts one Campaign, rebuilds its analytics rows, and creates exactly one Campaign Recipient per *(campaign, email, action)*.

**Conventions.** Log failures with `frappe.log_error(frappe.get_traceback(), "<clear title>")` so they can be found by title (section 6.7), and keep all Zoho calls inside `make_api_call()` so token handling stays in one place.

# Part 2: User manual

## 1. What this app does for you

Your Zoho Campaigns email results now appear inside ERPNext, refreshed automatically every hour. For each email campaign you can see how many people it reached, how many opened and clicked, how many bounced or unsubscribed, and who those people were. Each person is linked to their ERPNext Contact, so you can go from a campaign result straight to the person.

You do not need to log in to Zoho to check results. You also cannot change anything in Zoho from ERPNext: the connection is read-only.

## 2. Who can do what

| Task | Who |
| --- | --- |
| Set up the Zoho connection (Zoho Settings) | System Manager |
| Open the **Zoho Campaigns** dashboard | Sales User, Sales Manager, Sales Master Manager, System Manager |
| Press **Sync Now** on the dashboard | Sales Manager, Sales Master Manager, System Manager |
| See token expiry and sync errors on the dashboard | System Manager |
| Open a Campaign and its metrics | Anyone who can open Campaign records |
| Open the Campaign Recipient list | System Manager, unless an administrator grants access to other roles |
| Run the Campaign Performance report | Sales User, Sales Manager, Sales Master Manager, Manager Sales, HR Manager, System Manager |

If a button or page is missing for you, your role is probably not on this list. Ask your administrator.

## 3. One-time setup (administrator)

Do this once. It takes about ten minutes and you need a Zoho account that can create API clients.

1. Sign in to the Zoho API Console and create a **Server-based Application**.
2. For the redirect address, use your ERPNext web address followed by `/api/method/erpnext_zoho_integration.erpnext_zoho_integration.api.oauth.callback`. Copy the **Client ID** and **Client Secret**.
3. In ERPNext, open **Zoho Settings**. Enter the Client ID, Client Secret and the same redirect address, then **Save**.
4. Click **Authorize with Zoho**. Sign in to Zoho and approve the permissions it lists.
5. Your browser returns to a plain page that shows a long **code**. Copy it.
6. Go back to Zoho Settings, paste the code into the **Code** field, **Save**, and click **Fetch Tokens** right away. Zoho codes expire quickly, so do not leave this step for later.
7. Click **Test Connection**. A green message saying how many campaigns were found means the link works.
8. Click **Sync All Campaigns** for the first import. Larger accounts can take several minutes.

After this the **Authorize with Zoho** button disappears and the *Is Active* box is ticked. From now on ERPNext refreshes the data by itself every hour.

## 4. Reading the Zoho Campaigns dashboard

Open it by typing **Zoho Campaigns** in the search bar, or go to `/app/zoho-campaigns-dashboard`.

**The toolbar**

- **Period** chooses how far back to look: 30 Days, 90 Days (the default), 180 Days, 1 Year or All time. A campaign belongs to a period by the day it was sent.
- **Refresh** re-reads what ERPNext already holds. It is instant and does not contact Zoho.
- **Sync Now** asks Zoho for new numbers. It runs in the background, so wait a minute or two and then press **Refresh**.

**The cards**

| Card | What it tells you |
| --- | --- |
| Campaigns, Emails sent | How many campaigns went out in the period, and how many emails they contained |
| Avg open rate, Avg click rate | The average across campaigns, with larger sends counting for more, so a 50-person test does not distort the picture |
| Bounces, Unsubscribes | Totals for the period |
| Open and click rate by campaign | Compare campaigns side by side. With many campaigns this becomes a line over time |
| Recipient actions | How many opens, clicks, bounces and so on were recorded |
| Campaign performance | One row per campaign with its numbers. Click a name to open the campaign |
| Top countries, Top cities | Where engaged readers (those who opened or clicked) are |
| Most engaged contacts | People who clicked or opened across the most campaigns. Good for sales follow-up. Click a name to open the Contact |
| Sync health | Whether the connection is active and when it last synced. Administrators also see token expiry and recent errors |

The line at the very bottom, **Last synced from Zoho**, tells you how fresh the numbers are.

**If a note appears under the cards** about campaigns having no stored sent time, those campaigns are placed by the date they first reached ERPNext, so their position in the timeline may be slightly off. If it says the country, city and contact cards are a sample, see section 10.

## 5. Looking at a single campaign

Search for **Campaign** and open any campaign that came from Zoho.

- The **Zoho Campaign Data** section shows the subject, sender, reply-to, sent time, status and a preview link of the email as it was sent.
- The **Analytics** table lists every metric Zoho reported. Above it, coloured cards summarise the main ones: *Engagement Metrics* (opens, clicks, bounces, unsubscribes, complaints) and *Campaign Stats* (sent, delivered and rates).
- Click an engagement card to see the matching people. This opens the recipient list already filtered, if your role is allowed to see it.
- **Sync from Zoho** (top right) refreshes the analytics and the recipient list for this campaign right now, instead of waiting for the next hourly run. It does not update the subject or sent time.

The Zoho fields and the Analytics table are filled in by the sync. Do not edit them by hand, because the next sync will overwrite them.

## 6. Finding out who opened or clicked

Search for **Campaign Recipient**. Each row is **one person and one action in one campaign**. Someone who opened and then clicked appears twice, once as Opened and once as Clicked.

- Filter by **Campaign** and **Action Type** to answer questions such as *who clicked in last week's newsletter*.
- The coloured label shows the action: green for Opened, blue for Clicked, red for Unsubscribed or Complaint. Bounces appear in grey.
- Each row carries the person's name, company, job title and, where Zoho knows it, country, city and state.
- **Action Date** is the date the email was sent, not the moment the person opened or clicked it.
- ERPNext holds up to 100 people per action per campaign, so for very large sends the list is a sample (section 10).

## 7. Contacts

Every person in a campaign is linked to an ERPNext **Contact**.

- If a Contact with the same email address already exists, ERPNext links to it and adds a *Zoho Data* section with the Zoho ID, status and last sync time. Company and job title are filled in only when they are blank.
- If there is no match, ERPNext creates a new Contact. When Zoho has no first name, the Contact is called **Unknown**.
- Matching is by email, so a typo or a different address in ERPNext means a second Contact is created. Keep addresses consistent.

## 8. The Campaign Performance report

Open **Campaign Performance** from the report list (search for it in the search bar). It lists every Zoho campaign with sent time, emails sent, opens, open %, clicks, click %, bounces and unsubscribes.

- It has no date filter. It always shows every campaign.
- The first column shows the ERPNext document name (for example `SAL-CAM-2025-00001`), not the campaign title. Open the campaign to see the title.
- Use the **Menu** at the top right to export to Excel or CSV.

## 9. Metric glossary

These numbers are calculated by Zoho. ERPNext shows them exactly as Zoho reports them.

| Metric | Plain meaning |
| --- | --- |
| Emails Sent | Emails Zoho sent for the campaign |
| Delivered, Delivered % | Emails that were accepted by the recipient's mail server, and their share of the send |
| Opens, Open Rate % | Opens Zoho recorded, and the open rate. Open tracking is an estimate: mail apps that block or pre-load images can distort it |
| Unique Clicks, Click Rate % | People who clicked at least one link, and their share |
| Click-to-Open Rate | Of the people who opened, the share who also clicked |
| Bounces, Bounce Rate % | Emails that could not be delivered |
| Hard Bounces | Permanent failures, such as an address that does not exist |
| Soft Bounces | Temporary failures, such as a full mailbox |
| Unsubscribes, Unsubscribe Rate % | People who opted out through this campaign |
| Spam Complaints, Spam Rate % | People who marked the email as spam |
| Unopened, Unopened % | Delivered emails that were not opened |
| Forwards | Times the email was forwarded |

**Recipient action labels:** Opened, Clicked, Hard Bounced, Soft Bounced, Unsubscribed and Complaint.

## 10. How fresh the data is, and its limits

- **Updates hourly.** Zoho also needs time to compute statistics, so a campaign sent a few minutes ago may show zeros at first.
- **Only sent campaigns.** Drafts and scheduled campaigns are ignored.
- **Only the 50 most recent campaigns** are refreshed on each run. Older campaigns keep their last known numbers.
- **Campaign totals are complete. Recipient lists may not be.** ERPNext fetches up to 100 people for each action in each campaign. For a send to thousands of people, the recipient list, and therefore the country, city and contact cards, show a sample. The dashboard tells you when this applies. Zoho's own website always has the full list.
- **One direction only.** Nothing you change in ERPNext is sent back to Zoho.
- **Deleting a synced Campaign in ERPNext** does not delete it in Zoho, and it will reappear at the next sync if it is among the 50 most recent.

## 11. When something looks wrong

| What you see | What to do |
| --- | --- |
| The dashboard shows zeros | Change **Period** to **All time**. If the page says campaigns exist but are older than the period, you have your answer. If it says nothing is synced yet, ask an administrator to run the first sync |
| Numbers differ from Zoho's website | Press **Sync from Zoho** on the campaign. Small differences can remain because of timing and because the dashboard averages by audience size. Zoho remains the source of truth |
| A campaign is missing | It must be marked Sent in Zoho and be among the 50 most recent. A brand-new campaign can take up to an hour to appear |
| You cannot open Campaign Recipient | Your role does not include it. Ask an administrator for access |
| **Sync Now** says it started but nothing changes | Give it a few minutes, then press **Refresh**. If it still does not change, tell an administrator, who can look at the Sync health card and the Error Log |
| Last synced shows an old time | The automatic sync may have stopped. Tell an administrator |

## Quick reference

| I want to | Do this |
| --- | --- |
| See how campaigns performed overall | Open **Zoho Campaigns** and choose a **Period** |
| Get today's numbers from Zoho | Press **Sync Now**, wait a minute or two, then **Refresh** |
| Check one campaign | Open it in **Campaign** and read the cards and Analytics table |
| Update one campaign immediately | Open it and press **Sync from Zoho** |
| Find who clicked | **Campaign Recipient**, filter Campaign and Action Type = Clicked |
| Export all campaign numbers | **Campaign Performance** report, then Menu and Export |
| Reconnect Zoho (administrator) | **Zoho Settings**, then Authorize with Zoho, paste the Code, Fetch Tokens |