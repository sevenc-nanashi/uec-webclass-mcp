import * as v from "valibot";
export const timetableCourseSchema = v.object({
  name: v.string(),
  id: v.string(),
  url: v.string(),
});
export const timetableTimedCourseSchema = v.object({
  weekday: v.string(),
  period: v.string(),
  course: timetableCourseSchema,

  // 「その他のコース」での締め切りアラートがわからないので時間割のコース側に締め切りアラートの情報を持たせる
  hasDeadlineAlert: v.boolean(),
});
export const timetableUntimedCoursesSchema = v.object({
  category: v.string(),
  courses: v.array(
    v.object({
      subCategory: v.string(),
      courses: v.array(timetableCourseSchema),
    }),
  ),
});
export const timetableTargetOptionSchema = v.object({
  name: v.string(),
  id: v.string(),
});
export const timetableSchema = v.object({
  availableYears: v.array(timetableTargetOptionSchema),
  availableSemesters: v.array(timetableTargetOptionSchema),
  currentYear: v.string(),
  currentSemester: v.string(),
  timedCourses: v.array(timetableTimedCourseSchema),
  untimedCourses: v.array(timetableUntimedCoursesSchema),
});
export type TimetableCourse = v.InferOutput<typeof timetableCourseSchema>;
export type TimetableTimedCourse = v.InferOutput<
  typeof timetableTimedCourseSchema
>;
export type TimetableUntimedCourses = v.InferOutput<
  typeof timetableUntimedCoursesSchema
>;
export type TimetableTargetOption = v.InferOutput<
  typeof timetableTargetOptionSchema
>;
export type Timetable = v.InferOutput<typeof timetableSchema>;

export const courseContentSchema = v.object({
  url: v.string(),
  title: v.string(),
  kind: v.string(),
  availableDuring: v.optional(v.string()),
  numUsed: v.optional(v.number()),
});
export const courseSectionSchema = v.object({
  title: v.string(),
  contents: v.array(courseContentSchema),
});
export const courseTimelineSchema = v.object({
  content: v.string(),
  author: v.string(),
  datetime: v.string(),
});
export const courseSchema = v.object({
  id: v.string(),
  url: v.string(),
  timeline: v.array(courseTimelineSchema),
  sections: v.array(courseSectionSchema),
});
export type CourseContent = v.InferOutput<typeof courseContentSchema>;
export type CourseSection = v.InferOutput<typeof courseSectionSchema>;
export type CourseTimelineEntry = v.InferOutput<typeof courseTimelineSchema>;
export type Course = v.InferOutput<typeof courseSchema>;
