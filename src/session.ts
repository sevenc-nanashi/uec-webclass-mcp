import { launchBrowser } from "./browser.ts";
import { env } from "./env.ts";
import { TOTP } from "totp-generator";
import { isTargetUrl, UnreachableError } from "./utils.ts";
import { rootLogger } from "./log.ts";
import type {
  TimetableTargetOption,
  Course,
  CourseTimelineEntry,
  CourseSection,
  CourseContent,
  TimetableTimedCourse,
  TimetableUntimedCourses,
  Timetable,
} from "./model.ts";
import * as v from "valibot";
import { Mutex } from "./mutex.ts";

const sessionLogger = rootLogger.getChild("session");
const { browser, close } = await launchBrowser();
const context = await browser.newContext({
  locale: "ja-JP",
});
const page = await context.newPage();
page.on("load", () => {
  sessionLogger.info`Page loaded: ${page.url()}`;
});
const consoleLogger = rootLogger.getChild("console");
page.on("console", (msg) => {
  if (msg.type() === "error") {
    consoleLogger.error`${msg.text()}`;
  } else {
    consoleLogger.info`${msg.text()}`;
  }
});

const secret = new URL(env().UEC_TOTP_URL).searchParams.get("secret") as string;

const homeUrl = "https://webclass.cdel.uec.ac.jp/webclass/";
const ssoUrl = "https://shibboleth.cc.uec.ac.jp/idp/profile/SAML2/Redirect/SSO";
const ssoMfaUrl = "https://shibboleth.cc.uec.ac.jp/fl/saml/mfa/authentication";
const wcLoginUrl = "https://webclass.cdel.uec.ac.jp/webclass/login.php";
const loginActionUrls = [wcLoginUrl, ssoMfaUrl];

function isSsoStep(url: string, steps: number[]): boolean {
  if (!isTargetUrl(url, ssoUrl)) return false;
  const match = new URL(url).searchParams
    .get("execution")
    ?.match(/^e\d+s([124])$/);
  return match != null && steps.includes(Number(match[1]));
}

function isLoginActionUrl(url: string): boolean {
  return (
    loginActionUrls.some((actionUrl) => isTargetUrl(url, actionUrl)) ||
    isSsoStep(url, [2])
  );
}

class Session {
  private mutex = new Mutex();
  constructor() {}
  private async login(): Promise<void> {
    sessionLogger.info`Logging in to WebClass...`;

    await page.goto(homeUrl);

    const visitedUrls = new Set<string>();

    while (true) {
      await page.waitForURL(
        (url) => isLoginActionUrl(url.href) || isTargetUrl(url.href, homeUrl),
        {
          timeout: 10000,
        },
      );
      if (visitedUrls.has(page.url())) {
        throw new Error(
          `Loop detected in login flow, visited URL: ${page.url()}`,
        );
      }
      visitedUrls.add(page.url());

      if (isTargetUrl(page.url(), wcLoginUrl)) {
        sessionLogger.info`Filling in username and password for WebClass...`;
        const currentUrl = page.url();
        await page.locator("#username").fill(env().UEC_ID);
        await page.locator("#password").fill(env().UEC_PASSWORD);
        await page.locator('input[name="login"]').dispatchEvent("click");
        await page.waitForURL((url) => url.href !== currentUrl, {
          timeout: 10000,
        });
      } else if (isTargetUrl(page.url(), homeUrl)) {
        sessionLogger.info`Login successful!`;
        break;
      } else if (isSsoStep(page.url(), [2])) {
        sessionLogger.info`Filling in username and password for SSO...`;
        await page.locator('input[name="j_username"]').fill(env().UEC_ID);
        await page.locator('input[name="j_password"]').fill(env().UEC_PASSWORD);
        await page.locator('button[name="_eventId_proceed"]').click();
      } else if (isTargetUrl(page.url(), ssoMfaUrl)) {
        sessionLogger.info`Filling in TOTP for SSO...`;
        await page
          .locator('input[id="frm-authcode"]')
          .fill(await TOTP.generate(secret).then((otp) => otp.otp));
        await page.locator('input[name="login"]').click();
      } else {
        throw new UnreachableError(`Unexpected URL: ${page.url()}`);
      }
    }
  }

  async whoami(): Promise<{
    name: string;
    realName: string;
    emails: string[];
  }> {
    using _lock = await this.mutex.lock();

    sessionLogger.info`Fetching user information...`;
    await this.openPage(
      "https://webclass.cdel.uec.ac.jp/webclass/user.php/config",
    );
    const name = await page
      .locator("#UserIdTitle + div > p.form-control-static")
      .textContent();
    const realName = await page
      .locator('input[name="realname"]')
      .getAttribute("value")
      .then((c) => c ?? "");
    const emails = await page
      .locator('input[name="email"]')
      .getAttribute("value")
      .then((c) => c?.split(",") ?? []);
    return { name: name ?? "", realName, emails };
  }

  private async openPage(url: string): Promise<void> {
    await this.openPageImpl(0, url);
  }
  private async openPageImpl(nest: number, url: string): Promise<void> {
    sessionLogger.info`Opening page: ${url}`;
    const res = await page.goto(url);
    if (!res) {
      throw new Error(`Failed to open page: ${url}`);
    }
    await page.waitForURL(
      (url) =>
        isLoginActionUrl(url.href) ||
        isTargetUrl(url.href, homeUrl) ||
        isTargetUrl(url.href, url.href),
      { timeout: 10000 },
    );
    if (!isTargetUrl(page.url(), url)) {
      if (nest >= 3) {
        throw new Error(
          `Failed to open page after multiple login attempts: ${url}`,
        );
      }
      sessionLogger.info`Detected login required. Logging in...`;
      await this.login();
      await this.openPageImpl(nest + 1, url);
    } else {
      sessionLogger.info`Page opened successfully: ${url}`;
    }
  }

  async getTimetable(
    target: { year: string; semester: string } | undefined = undefined,
  ): Promise<Timetable> {
    using _lock = await this.mutex.lock();

    sessionLogger.info`Fetching timetable...`;
    if (target) {
      await this.openPage(
        `https://webclass.cdel.uec.ac.jp/webclass/index.php?year=${target.year}&semester=${target.semester}`,
      );
    } else {
      await this.openPage("https://webclass.cdel.uec.ac.jp/webclass/");
    }

    const availableYears = await page
      .locator('select[name="year"] > option')
      .evaluateAll((options) =>
        options.map(
          (option): TimetableTargetOption => ({
            name: option.textContent?.trim() ?? "",
            id: option.getAttribute("value") ?? "",
          }),
        ),
      );

    const availableSemesters = await page
      .locator('select[name="semester"] > option')
      .evaluateAll((options) =>
        options.map(
          (option): TimetableTargetOption => ({
            name: option.textContent?.trim() ?? "",
            id: option.getAttribute("value") ?? "",
          }),
        ),
      );
    const currentYear = await page
      .locator('select[name="year"] > option[selected]')
      .getAttribute("value");
    const currentSemester = await page
      .locator('select[name="semester"] > option[selected]')
      .getAttribute("value");

    let timedCourses: TimetableTimedCourse[] = [];
    let untimedCourses: TimetableUntimedCourses[] = [];
    if ((await page.locator("#schedule-table").count()) === 0) {
      sessionLogger.warning`No timed courses found.`;
    } else {
      sessionLogger.info`Parsing courses from the timetable...`;
      const weekdayRow = await page
        .locator("#schedule-table > thead > tr > th")
        .allTextContents();
      if (weekdayRow.length === 0) {
        throw new Error("Failed to parse weekday row from the timetable.");
      }
      timedCourses = await page
        .locator("#schedule-table > tbody > tr")
        .evaluateAll((rows, weekdayRow) => {
          return rows.flatMap((row) => {
            const cells = Array.from(row.querySelectorAll("td"));
            const period = cells[0].textContent?.trim() ?? "";
            const courses: TimetableTimedCourse[] = [];
            for (const [index, cell] of cells.entries()) {
              const link = cell.querySelector("a");
              if (link) {
                const url = new URL(
                  link.getAttribute("href") ?? "",
                  "https://webclass.cdel.uec.ac.jp/webclass/",
                ).href;
                const id = url.match(/course.php\/([^/]+)/)?.[1] ?? "";
                const name = (
                  link.childNodes[0]?.textContent?.trim() ?? ""
                ).replace("» ", "");
                // NOTE: 名前的に締め切りアラート以外も入りそう...
                const hasDeadlineAlert = !!cell.querySelector(
                  ".course-contents-info",
                );
                courses.push({
                  weekday: weekdayRow[index],
                  period,
                  deadlineAlert: hasDeadlineAlert,
                  course: {
                    id,
                    name,
                    url,
                  },
                });
              }
            }

            return courses;
          });
        }, weekdayRow);
    }

    untimedCourses = await page
      .locator(".courseTree.courseLevelOne")
      .evaluateAll((items): TimetableUntimedCourses[] =>
        items.map((item) => {
          const category =
            item.querySelector(".courseTree-levelTitle")?.textContent?.trim() ??
            "";
          const subCategories = Array.from(
            item.querySelectorAll(".courseTree.courseLevelTwo"),
          ).map((subItem): TimetableUntimedCourses["courses"][number] => {
            const subCategory =
              subItem.querySelector(".title h5")?.textContent?.trim() ?? "";
            const courses = Array.from(
              subItem.querySelectorAll(".course-title"),
            ).map(
              (
                courseItem,
              ): TimetableUntimedCourses["courses"][number]["courses"][number] => {
                const link = courseItem.querySelector("a");
                const url = new URL(
                  link?.getAttribute("href") ?? "",
                  "https://webclass.cdel.uec.ac.jp/webclass/",
                ).href;
                const id = url.match(/course.php\/([^/]+)/)?.[1] ?? "";
                return {
                  id,
                  name: link?.textContent?.trim() ?? "",
                  url,
                };
              },
            );

            return {
              subCategory,
              courses,
            };
          });

          return {
            category,
            courses: subCategories,
          };
        }),
      );

    return {
      availableYears,
      availableSemesters,
      currentYear: currentYear ?? "",
      currentSemester: currentSemester ?? "",
      timedCourses,
      untimedCourses,
    };
  }

  async getCourse(courseId: string): Promise<Course> {
    using _lock = await this.mutex.lock();

    sessionLogger.info`Fetching course information for course ID: ${courseId}...`;
    await this.openPage(
      `https://webclass.cdel.uec.ac.jp/webclass/course.php/${courseId}/`,
    );

    const rawTimeline = await page.evaluate(async (courseId) => {
      return await fetch(
        `https://webclass.cdel.uec.ac.jp/webclass/course.php/${courseId}/api/timeline/messages?head=1`,
      ).then((res) => res.json());
    }, courseId);
    const rawTimelineSchema = v.object({
      records: v.array(
        v.object({
          message: v.string(),
          realname: v.string(),
          datetime: v.number(),
        }),
      ),
    });
    const parsedTimeline = v.parse(rawTimelineSchema, rawTimeline);
    const timeline = parsedTimeline.records.map(
      (record): CourseTimelineEntry => ({
        content: record.message,
        author: record.realname,
        datetime: new Date(record.datetime * 1000).toISOString(),
      }),
    );

    const sections = await page
      .locator(".cl-contentsList_folder")
      .evaluateAll((folders): CourseSection[] => {
        return folders.map((folder) => {
          const title =
            folder.querySelector(".panel-title")?.textContent?.trim() ?? "";
          const contents = Array.from(
            folder.querySelectorAll(".cl-contentsList_listGroupItem"),
          ).map((item): CourseContent => {
            const title =
              item
                .querySelector(".cm-contentsList_contentName")
                ?.textContent?.trim() ?? "";
            const kind =
              item
                .querySelector(".cl-contentsList_categoryLabel")
                ?.textContent?.trim() ?? "";
            let availableDuring: string | undefined = undefined;
            let url: string = "";
            let numUsed: number | undefined = undefined;

            for (const child of item.querySelectorAll(
              ".cm-contentsList_contentDetailListItem",
            )) {
              const label = child
                .querySelector(".cm-contentsList_contentDetailListItemLabel")
                ?.textContent?.trim();
              const data = child
                .querySelector(".cm-contentsList_contentDetailListItemData")
                ?.textContent?.trim();
              if (label === "利用可能期間") {
                availableDuring = data ?? undefined;
              }
            }
            for (const child of item.querySelectorAll(
              ".cl-contentsList_contentDetailListItem",
            )) {
              const label = child
                .querySelector(".cl-contentsList_contentDetailListItemLabel")
                ?.textContent?.trim();
              const data = child
                .querySelector(".cl-contentsList_contentDetailListItemData")
                ?.textContent?.trim();
              if (!label && data === "詳細") {
                url = new URL(
                  child.querySelector("a")?.getAttribute("href") ?? "",
                  "https://webclass.cdel.uec.ac.jp/webclass/",
                ).href;
              } else if (data?.startsWith("利用回数")) {
                numUsed = parseInt(data.split(" ")[1].trim(), 10);
              }
            }

            return {
              title,
              url,
              kind,
              availableDuring,
              numUsed,
            };
          });

          return {
            title,
            contents,
          };
        });
      });

    return {
      id: courseId,
      url: page.url(),
      timeline,
      sections,
    };
  }

  async exit(): Promise<void> {
    await page.close();
    await context.close();
    await close();
  }
}

const session = new Session();
export default session;
