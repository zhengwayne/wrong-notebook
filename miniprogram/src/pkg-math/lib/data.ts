/** 数学星图数据：从 math.jjool.com 下载并缓存在本机（约 1.5 MB，过期 3 天后台更新） */
import { loadRemoteJson } from '../../utils/remote-data';
import { MATH_BASE } from './course';
import type { Course, Question } from './course';

const MAX_AGE = 3 * 24 * 60 * 60 * 1000;

export function loadCourse(): Promise<Course> {
  return loadRemoteJson<Course>('math-course', `${MATH_BASE}/data/course.json`, MAX_AGE);
}

export function loadArt(): Promise<string[]> {
  return loadRemoteJson<string[]>('math-art', `${MATH_BASE}/data/art.json`, MAX_AGE).catch(() => []);
}

export async function loadQuestions(): Promise<{ kpQuiz: Record<string, Question[]>; bank: Question[] }> {
  const [kpQuiz, bank] = await Promise.all([
    loadRemoteJson<Record<string, Question[]>>('math-kp-quiz', `${MATH_BASE}/data/kp-quiz.json`, MAX_AGE),
    loadRemoteJson<Question[]>('math-questions', `${MATH_BASE}/data/questions.json`, MAX_AGE),
  ]);
  return { kpQuiz, bank };
}
