import sys
import os
import re
import time
import random
import json
import argparse
import urllib.parse

from datetime import datetime

import pandas as pd

from bs4 import BeautifulSoup

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError
)


# ==========================================
# 1. TARGET JOB PLATFORMS
# ==========================================
TARGET_PLATFORMS = [
    {
        "name": "LinkedIn",
        "domains": ["linkedin.com"],
        "search_keyword": "site:linkedin.com/jobs/view"
    }
]


# ==========================================
# 2. EXTRACT HR CONTACT INFORMATION
# ==========================================
def extract_hr_contact(text: str) -> str:

    if not text:
        return "Not Disclosed"

    contacts = []

    emails = re.findall(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        text
    )

    contacts.extend(emails)

    phones = re.findall(
        r"(?:\+91[\s-]?)?[6-9]\d{9}\b",
        text
    )

    contacts.extend(phones)

    contacts = list(dict.fromkeys(contacts))

    if contacts:
        return " | ".join(contacts[:10])

    return "Not Disclosed"


# ==========================================
# HR EXCEL INTEGRATION
# ==========================================

HR_EXCEL_FILE = "leads_with_hr.xlsx"


def normalize_match(value):
    value = str(value or "").strip().lower()
    return re.sub(r"[^a-z0-9]", "", value)


def load_existing_hr_data():

    if not os.path.exists(HR_EXCEL_FILE):
        print("[-] HR Excel file not found:", HR_EXCEL_FILE)
        return {}, {}

    df = pd.read_excel(HR_EXCEL_FILE)

    by_url = {}
    by_company_job = {}

    for _, row in df.iterrows():

        job_url = str(row.get("Job URL", "")).strip()
        company = normalize_match(row.get("Company", ""))
        title = normalize_match(row.get("Job Title", ""))

        hr_data = {
            "HR NAME": row.get("HR Name", ""),
            "HR TITLE": row.get("HR Title", ""),
            "HR EMAIL": row.get("HR Email", ""),
            "HR PHONE": row.get("Mobile NO:", ""),
            "HR PROFILE URL": row.get("HR Profile URL", "")
        }

        if job_url and job_url.lower() != "nan":
            by_url[job_url.rstrip("/").lower()] = hr_data

        if company and title:
            by_company_job[(company, title)] = hr_data

    print("[+] Existing HR records loaded:", len(df))

    return by_url, by_company_job


def match_existing_hr(lead, hr_indexes):

    by_url, by_company_job = hr_indexes

    url = str(lead.get("JOB URL", "")).strip().rstrip("/").lower()
    company = normalize_match(lead.get("COMPANY", ""))
    title = normalize_match(lead.get("JOB TITLE", ""))

    hr_data = by_url.get(url)

    if not hr_data:
        hr_data = by_company_job.get((company, title))

    if not hr_data:
        return lead

    for field, value in hr_data.items():
        if pd.notna(value) and str(value).strip():
            lead[field] = str(value).strip()

    contacts = []

    for field in ["HR EMAIL", "HR PHONE"]:
        value = lead.get(field, "")
        if value and value != "Not Disclosed":
            contacts.append(value)

    if contacts:
        lead["HR CONTACT"] = " | ".join(contacts)
    file_status = str(lead.get("VERIFICATION", "")).strip().lower()
    hr_email = str(lead.get("HR EMAIL", "")).strip().lower()
    local_part = hr_email.split("@")[0] if "@" in hr_email else ""
    generic_names = {
        "careers", "career", "jobs", "job", "hr", "info", "contact",
        "hello", "support", "admin", "recruitment", "recruiter",
        "talent", "hiring", "office", "mail", "enquiry", "inquiry",
        "apply", "team",
    }

    if not hr_email or hr_email == "not disclosed":
        lead["VERIFICATION"] = "Not Disclosed"
    elif local_part in generic_names:
        lead["VERIFICATION"] = "Unverified (generic email)"
    elif file_status == "verified":
        lead["VERIFICATION"] = "Verified"
    else:
        lead["VERIFICATION"] = "Unverified (HR data matched)"

    return lead

def harvest_google_links_for_platform(
    page,
    base_query: str,
    platform: dict
) -> list:

    contacts = []

    # Extract email addresses
    emails = re.findall(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        text
    )

    for email in emails:
        if email not in contacts:
            contacts.append(email)

    # Extract Indian phone numbers
    phones = re.findall(
        r"(?:\+91[\s-]?)?[6-9]\d{9}\b",
        text
    )

    for phone in phones:
        if phone not in contacts:
            contacts.append(phone)

    contacts = list(dict.fromkeys(contacts))

    if contacts:
        return " | ".join(contacts[:10])

    return "Not Disclosed"
def harvest_google_links_for_platform(
    page,
    base_query: str,
    platform: dict
) -> list:

    search_term = (
        f"{base_query} {platform['search_keyword']}"
    )

    search_url = (
        "https://www.google.com/search?q="
        + urllib.parse.quote(search_term)
        + "&num=20"
    )

    print(f"\n[*] Searching: {search_term}")

    try:
        page.goto(
            search_url,
            wait_until="domcontentloaded",
            timeout=25000
        )
        page.wait_for_timeout(2000)

        # TEMPORARY DEBUGGING
        print("Page title:", page.title())
        print("Current URL:", page.url)

        body_text = page.locator("body").inner_text()
        print("Page preview:")
        print(body_text[:1000])

    except Exception as e:
        print(f"[-] Search failed: {e}")
        return []

    found_links = []
    seen_urls = set()

    for heading in page.query_selector_all("h3"):

        try:
            title = heading.inner_text().strip()

            if not title:
                continue

            parent = heading.query_selector(
                "xpath=ancestor::a"
            )

            if not parent:
                continue

            href = parent.get_attribute("href") or ""

            if href.startswith("/url?"):
                params = urllib.parse.parse_qs(
                    urllib.parse.urlparse(href).query
                )
                href = params.get(
                    "q", params.get("url", [""])
                )[0]

            if not href.startswith("http"):
                continue

            host = urllib.parse.urlparse(
                href
            ).netloc.lower()

            if not any(
                domain in host
                for domain in platform["domains"]
            ):
                continue

            cleaned_url = clean_job_url(href)

            if cleaned_url and cleaned_url not in seen_urls:

                seen_urls.add(cleaned_url)

                found_links.append({
                    "url": cleaned_url,
                    "title": title,
                    "platform": platform["name"]
                })

        except Exception:
            continue

    print(
        f"[+] Found {len(found_links)} links "
        f"for {platform['name']}"
    )

    return found_links


# ==========================================
# 6. CLEAN JOB URL
# ==========================================

def clean_job_url(raw_url: str) -> str:

    if not raw_url:
        return ""

    try:
        parsed = urllib.parse.urlparse(raw_url)
        netloc = parsed.netloc.lower()

        if "indeed." in netloc:

            match = re.search(
                r"[?&]jk=([a-zA-Z0-9]+)",
                raw_url
            )

            if match:
                return (
                    f"https://{netloc}/viewjob"
                    f"?jk={match.group(1)}"
                )

        if "naukri.com" in netloc:
            return raw_url.split("?")[0]

        params = urllib.parse.parse_qs(parsed.query)

        for key in list(params):
            if key.lower().startswith("utm_"):
                params.pop(key, None)

        clean_query = urllib.parse.urlencode(
            params,
            doseq=True
        )

        return urllib.parse.urlunparse((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            clean_query,
            ""
        ))

    except Exception:
        return raw_url


# ==========================================
# 7. DETECT LOCATION FROM SEARCH QUERY
# ==========================================

def parse_target_location(query: str) -> str:

    locations = [
        "Hyderabad", "Warangal", "Bangalore",
        "Bengaluru", "Chennai", "Pune",
        "Mumbai", "Delhi", "Gurgaon",
        "Noida", "Kolkata", "Remote"
    ]

    query_lower = query.lower()

    for location in locations:
        if location.lower() in query_lower:
            return location

    return "Not Disclosed"


# ==========================================
# 8. EXTRACT JOB LOCATION
# ==========================================

def extract_location(
    page,
    item_json: dict,
    fallback_text: str,
    query: str
) -> str:

    try:
        job_location = item_json.get("jobLocation", [])

        if isinstance(job_location, dict):
            job_location = [job_location]

        for item in job_location:

            address = item.get("address", {})

            if isinstance(address, str) and address.strip():
                return address.strip()

            if isinstance(address, dict):

                parts = [
                    address.get("addressLocality"),
                    address.get("addressRegion"),
                    address.get("addressCountry")
                ]

                location = ", ".join(
                    str(part).strip()
                    for part in parts
                    if part
                )

                if location:
                    return location

    except Exception:
        pass

    if re.search(
        r"\b(remote|work from home|wfh)\b",
        fallback_text or "",
        re.IGNORECASE
    ):
        return "Remote"

    return parse_target_location(query)


# ==========================================
# 9. EXTRACT CONTACTS FROM JOB PAGE
# ==========================================

# ==========================================
# 9. EXTRACT CONTACTS FROM JOB PAGE
# ==========================================

def extract_page_contacts(page, page_text: str, company: str) -> str:

    contacts = []

    try:
        for link in page.query_selector_all('a[href^="mailto:"]'):
            href = link.get_attribute("href") or ""
            email = href.replace("mailto:", "").split("?")[0].strip()

            if re.match(
                r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$",
                email
            ):
                contacts.append(email)

        for link in page.query_selector_all('a[href^="tel:"]'):
            phone = (link.get_attribute("href") or "").replace(
                "tel:", ""
            ).strip()

            if len(re.sub(r"\D", "", phone)) >= 10:
                contacts.append(phone)

    except Exception:
        pass

    emails = re.findall(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        page_text or ""
    )

    phones = re.findall(
        r"(?:\+91[\s-]?)?[6-9]\d{9}\b",
        page_text or ""
    )

    contacts.extend(emails)
    contacts.extend(phones)

    contacts = list(dict.fromkeys(contacts))

    if contacts:
        return " | ".join(contacts[:10])

    return "Not Disclosed"


# ==========================================
# 10. IDENTIFY JOB ROLE
# ==========================================

def infer_role(title: str, query: str = "") -> str:

    t = (title or "").lower()

    if "machine learning" in t:
        return "Machine Learning Engineer"
    elif "artificial intelligence" in t:
        return "AI Engineer"
    elif "data scientist" in t or "data science" in t:
        return "Data Science"
    elif "data analyst" in t:
        return "Data Analyst"
    elif "python" in t:
        return "Python Developer"
    elif "java" in t:
        return "Java Developer"
    elif "intern" in t or "trainee" in t:
        return "Internship"
    elif "software" in t or "developer" in t:
        return "Software Developer"

    return title.strip() if title else "Intern / Trainee"


# ==========================================
# 11. CALCULATE LEAD SCORE
# ==========================================

def calculate_lead_score(lead: dict) -> int:

    score = 0

    if lead.get("COMPANY"):
        score += 20

    if lead.get("JOB TITLE"):
        score += 20

    if lead.get("AREA / LOCATION") != "Not Disclosed":
        score += 10

    if lead.get("SALARY") != "Not Disclosed":
        score += 10

    if lead.get("HR CONTACT") != "Not Disclosed":
        score += 20

    if len(lead.get("FULL DESCRIPTION", "")) >= 200:
        score += 20

    return min(score, 100)
# ==========================================
# 12. SCRAPE INDIVIDUAL JOB PAGE
# ==========================================

def scrape_job_page(page, job: dict, query: str) -> dict:

    url = job.get("url", "")
    search_title = job.get("title", "")
    platform = job.get("platform", "Unknown")

    lead = {
        "SCORE": 0,
        "COMPANY": "",
        "JOB TITLE": "",
        "ROLE": "",
        "AREA / LOCATION": "Not Disclosed",
        "SALARY": "Not Disclosed",
        "HR CONTACT": "Not Disclosed",
        "VERIFICATION": "Unverified",
        "STAGE": "Discovered",
        "SOURCE": platform,
        "DISCOVERED": datetime.now().strftime("%Y-%m-%d"),
        "JOB URL": url,
        "FULL DESCRIPTION": ""
    }

    try:
        page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=30000
        )

        page.wait_for_timeout(1500)

        page_text = page.locator("body").inner_text(
            timeout=10000
        )

        job_data = {}

        try:
            scripts = page.locator(
                'script[type="application/ld+json"]'
            ).all()

            for script in scripts:
                try:
                    data = json.loads(script.inner_text())
                except Exception:
                    continue

                objects = data if isinstance(data, list) else [data]

                for obj in objects:
                    if not isinstance(obj, dict):
                        continue

                    if obj.get("@type") == "JobPosting":
                        job_data = obj
                        break

                if job_data:
                    break

        except Exception:
            pass

        # Job title
        title = job_data.get("title", "")

        if not title:
            for selector in [
                "h1",
                '[data-testid="job-title"]',
                ".job-title"
            ]:
                try:
                    element = page.query_selector(selector)

                    if element:
                        title = element.inner_text().strip()

                        if title:
                            break

                except Exception:
                    continue

        if not title:
            title = search_title

        # Company name
        company = ""

        hiring_org = job_data.get("hiringOrganization", {})

        if isinstance(hiring_org, dict):
            company = hiring_org.get("name", "")

        if not company:
            for selector in [
                '[data-testid="company-name"]',
                ".company-name",
                '[class*="companyName"]'
            ]:
                try:
                    element = page.query_selector(selector)

                    if element:
                        company = element.inner_text().strip()

                        if company:
                            break

                except Exception:
                    continue

        # Description
        description = job_data.get("description", "")

        if description:
            description = BeautifulSoup(
                description,
                "html.parser"
            ).get_text(" ", strip=True)

        if not description:
            description = page_text[:12000]

        # Location
        location = extract_location(
            page,
            job_data,
            page_text,
            query
        )

        # Contact
        contact = extract_page_contacts(
            page,
            page_text,
            company
        )

        lead.update({
            "COMPANY": company.strip(),
            "JOB TITLE": title.strip(),
            "ROLE": infer_role(title, query),
            "AREA / LOCATION": location,
            "HR CONTACT": contact,
            "FULL DESCRIPTION": description[:12000],
            "VERIFICATION": (
                "Partially Verified"
                if title and company
                else "Unverified"
            )
        })

        lead["SCORE"] = calculate_lead_score(lead)

        return lead

    except Exception as e:

        print(f"[-] Job page error: {e}")

        lead["VERIFICATION"] = "Error"
        lead["FULL DESCRIPTION"] = ""

        return lead
    # ==========================================
# 13. VALIDATE JOB LEADS
# ==========================================

def is_valid_lead(lead: dict) -> bool:

    title = str(lead.get("JOB TITLE") or "").strip()
    company = str(lead.get("COMPANY") or "").strip()
    description = str(
        lead.get("FULL DESCRIPTION") or ""
    ).strip()

    invalid_values = [
        "", "none", "nan", "unknown",
        "job listing", "jobs", "careers"
    ]

    if title.lower() in invalid_values:
        return False

    if company.lower() in invalid_values:
        return False

    if lead.get("VERIFICATION") == "Error":
        return False

    if len(description) < 80:
        return False

    return True


# ==========================================
# 14. MAIN JOB SCRAPER
# ==========================================

def run_master_job_army(
    search_query: str,
    headful: bool = False,
    limit=None
) -> list:

    if not search_query or not search_query.strip():
        raise ValueError("Please provide a job search query.")

    if limit is not None:
        limit = int(limit)

        if limit <= 0:
            return []

    all_leads = []
    seen_urls = set()
    hr_indexes = load_existing_hr_data()
    print("\n===================================")
    print("       MASTER JOB ARMY")
    print("===================================")
    print("Query:", search_query)

    with sync_playwright() as playwright:

        browser = None

        try:
            try:
                browser = playwright.chromium.launch(
                    channel="chrome",
                    headless=not headful
                )
            except Exception:
                browser = playwright.chromium.launch(
                    headless=not headful
                )

            context = browser.new_context()
            page = context.new_page()

            for platform in TARGET_PLATFORMS:

                if limit is not None and len(all_leads) >= limit:
                    break

                try:
                    jobs = harvest_google_links_for_platform(
                        page,
                        search_query,
                        platform
                    )

                    for job in jobs:

                        if limit is not None and len(all_leads) >= limit:
                            break
                        url = job.get("url", "")

                        if not url or url in seen_urls:
                            continue

                        seen_urls.add(url)

                        print("\n[*] Scraping:", url)

                        lead = scrape_job_page(
                            page,
                            job,
                            search_query
                        )

                        lead = match_existing_hr(lead, hr_indexes)

                        lead["SCORE"] = calculate_lead_score(lead)

                        if is_valid_lead(lead):
                            all_leads.append(lead)

                            print(
                                "[+] Valid lead:",
                                lead["COMPANY"],
                                "| Score:",
                                lead["SCORE"]
                            )
                        else:
                            print("[-] Invalid lead skipped")

                        time.sleep(random.uniform(1, 2))

                        

                except Exception as e:
                    print(
                        f"[-] Platform error "
                        f"{platform['name']}: {e}"
                    )

            all_leads.sort(
                key=lambda item: item.get("SCORE", 0),
                reverse=True
            )

            if limit is not None:
                all_leads = all_leads[:limit]

            print("\n===================================")
            print("SCRAPING COMPLETED")
            print("Valid leads:", len(all_leads))
            print("===================================")

            return all_leads

        finally:
            if browser:
                browser.close()


# ==========================================
# 15. COMMAND LINE EXECUTION
# ==========================================

if __name__ == "__main__":

    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--query",
        type=str,
        default="Python Developer Hyderabad"
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=5
    )

    parser.add_argument(
        "--headful",
        action="store_true"
    )

    args = parser.parse_args()

    results = run_master_job_army(
        search_query=args.query,
        headful=args.headful,
        limit=args.limit
    )

    if results:
        df = pd.DataFrame(results)

        filename = (
            "linkedin_job_leads_"
+ datetime.now().strftime("%Y%m%d_%H%M%S")
+ ".xlsx"
        )

        df.to_excel(filename, index=False)

        print("\nExcel file saved:", filename)

    else:
        print("\nNo valid leads found.")