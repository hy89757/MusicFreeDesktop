/**
 * autoLyricSearch — 播放无歌词的歌曲时，自动搜索并关联歌词
 *
 * 触发时机：LyricManager.fetchLyric 走完全部获取途径（用户关联歌词、内嵌
 * rawLrc、本地同名 .lrc 文件、插件 getLyric、远程 lrcUrl）仍未拿到歌词时。
 *
 * 关键约束：
 * - 仅在用户开启 lyric.autoSearch 时执行
 * - 每首歌最多自动搜索一次（结果记录到 mediaMeta.autoLyricSearched），
 *   避免每次播放都向插件发起请求
 * - 搜索结果需通过标题 + 歌手相似度校验；宁可不关联，也不关联错误歌词
 * - 切歌后丢弃在途结果，不覆盖新歌曲的歌词状态
 * - 插件调用异常（如网络故障）不写标记，保留下次重试机会；
 *   搜索成功但无匹配结果则写标记，避免反复空搜
 */
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import appConfig from '@infra/appConfig/renderer';
import { compositeKey, isSameMedia } from '@common/mediaKey';

/** 标题相似度下限：低于此值直接判定不是同一首歌 */
const TITLE_MIN_SCORE = 0.75;
/** 标题与歌手加权综合分的下限 */
const TOTAL_MIN_SCORE = 0.65;
/** 歌手分低于此值视为"明显不是同一位歌手"，直接拒绝 */
const ARTIST_MISMATCH_SCORE = 0.3;
/** 歌手信息缺失时，标题需要更高的相似度才接受 */
const TITLE_ONLY_MIN_SCORE = 0.85;
/** 按得分顺位尝试获取歌词的候选上限 */
const MAX_LINK_TRIES = 3;

/** 正在自动搜索的歌曲，防止同一首并发重复搜索 */
const pendingKeys = new Set<string>();

/**
 * 归一化字符串用于宽松比对：去掉括号修饰（如 (Live)、【官方版】）、
 * 标点与空白，统一小写。保留中日韩字符与字母数字。
 */
function normalizeForMatch(input: string): string {
    return input
        .replace(/[[(（【][^)\]）】]*[)\]）】]/g, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
        .trim();
}

/** Levenshtein 编辑距离（滚动数组实现） */
function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = new Array<number>(b.length + 1);
    let curr = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

/** 两个字符串的相似度，取值 0～1 */
function similarity(a: string, b: string): number {
    const na = normalizeForMatch(a);
    const nb = normalizeForMatch(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    return 1 - editDistance(na, nb) / Math.max(na.length, nb.length);
}

/** 拆分歌手串（常见形式："A, B" / "A/B" / "A & B" / "A、B"） */
function splitArtists(input: string): string[] {
    return normalizeForMatch(input)
        .split(/\s*[,/、&]\s*|\s+/)
        .filter(Boolean);
}

/**
 * 歌手匹配度。
 *
 * 返回 null 表示一方歌手信息缺失；返回 0 表示双方都有信息但明显不是同一歌手。
 * 歌词源与本地曲库的歌手写法常有差异（合作歌手顺序不同、一方只写主唱），
 * 因此除全等外，也接受"一方包含另一方的某个歌手名"的情况。
 */
function artistSimilarity(target?: string, candidate?: string): number | null {
    const t = normalizeForMatch(target ?? '');
    const c = normalizeForMatch(candidate ?? '');
    if (!t || !c) return null;
    if (t === c) return 1;

    for (const name of splitArtists(t)) {
        // 单字符易误匹配（如 "A"），要求至少 2 个字符
        if (name.length >= 2 && c.includes(name)) return 0.9;
    }
    for (const name of splitArtists(c)) {
        if (name.length >= 2 && t.includes(name)) return 0.9;
    }
    // 整体编辑距离兜底，略降权；完全不同时为 0
    return similarity(t, c) * 0.8;
}

/**
 * 综合打分：标题为主，歌手为辅。
 *
 * - 双方歌手都有信息但明显不符 → 直接拒绝（重名歌曲/翻唱版本）
 * - 歌手吻合度正常 → 标题 + 歌手加权综合分需过下限
 * - 歌手信息缺失时只看标题，但要求更严格的标题相似度
 */
function scoreCandidate(target: IMusic.IMusicItem, candidate: ILyric.ILyricItem): number {
    const titleScore = similarity(target.title ?? '', candidate.title ?? '');
    const artist = artistSimilarity(target.artist, candidate.artist);

    if (artist !== null) {
        if (titleScore < TITLE_MIN_SCORE) return 0;
        // 双方都有歌手信息但明显不符：多为重名歌曲或翻唱版本，
        // 歌词文本可能相同但时间轴对不上，宁可不关联
        if (artist < ARTIST_MISMATCH_SCORE) return 0;
        const total = titleScore * 0.7 + artist * 0.3;
        return total >= TOTAL_MIN_SCORE ? total : 0;
    }

    return titleScore >= TITLE_ONLY_MIN_SCORE ? titleScore : 0;
}

/**
 * 向所有支持歌词搜索的插件发起搜索，汇总候选结果。
 *
 * @returns 候选列表；hasError 表示存在插件调用失败（与"搜到但无匹配"区分开）
 */
async function searchCandidates(
    query: string,
): Promise<{ items: ILyric.ILyricItem[]; hasError: boolean }> {
    const plugins = pluginManager.getSearchablePlugins('lyric');
    if (plugins.length === 0) return { items: [], hasError: false };

    const settled = await Promise.allSettled(
        plugins.map((plugin) =>
            pluginManager.callPluginMethod({
                hash: plugin.hash,
                method: 'search',
                args: [query, 1, 'lyric'],
            }),
        ),
    );

    const items: ILyric.ILyricItem[] = [];
    let hasError = false;

    for (const result of settled) {
        if (result.status === 'rejected') {
            hasError = true;
            continue;
        }
        const data = result.value?.data;
        if (Array.isArray(data)) {
            items.push(...(data as ILyric.ILyricItem[]));
        }
    }
    return { items, hasError };
}

/**
 * 从候选中按得分挑出最多 MAX_LINK_TRIES 个（降序），并排除歌曲自身。
 *
 * 注意：对全部候选打分后再排序截断。不能先截断——多插件结果拼接后，
 * 先截断会让第一个插件的长列表挤掉其他插件的更优匹配。
 */
function pickCandidates(
    musicItem: IMusic.IMusicItem,
    candidates: ILyric.ILyricItem[],
): Array<{ item: ILyric.ILyricItem; score: number }> {
    const scored: Array<{ item: ILyric.ILyricItem; score: number }> = [];

    for (const candidate of candidates) {
        if (!candidate || !candidate.platform || candidate.id == null) continue;
        // 自引用保护：关联到自己会被 getLyricAdapter 忽略，且无意义
        if (isSameMedia(candidate, musicItem)) continue;

        const score = scoreCandidate(musicItem, candidate);
        if (score > 0) scored.push({ item: candidate, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_LINK_TRIES);
}

export interface IAutoSearchResult {
    /** 是否成功关联到歌词 */
    linked: boolean;
    /** 命中的歌词来源，用于界面提示 */
    matched?: ILyric.ILyricItem;
}

/**
 * 为指定歌曲自动搜索歌词并关联。
 *
 * @param musicItem 目标歌曲
 * @param isStale 判断该歌曲是否已不是当前播放项，用于丢弃过时结果
 */
export async function autoSearchLyric(
    musicItem: IMusic.IMusicItem,
    isStale: () => boolean,
): Promise<IAutoSearchResult> {
    const NOT_LINKED: IAutoSearchResult = { linked: false };

    if (!appConfig.getConfigByKey('lyric.autoSearch')) return NOT_LINKED;

    const query = `${musicItem.title ?? ''} ${musicItem.artist ?? ''}`.trim();
    // 标题都没有就无法搜索
    if (!musicItem.title || !query) return NOT_LINKED;

    const platform = musicItem.platform;
    const musicId = String(musicItem.id);
    const key = compositeKey(platform, musicId);

    // 同一首歌正在搜索中，直接跳过
    if (pendingKeys.has(key)) return NOT_LINKED;

    const meta = await mediaMeta.getMeta(platform, musicId);
    // 已搜索过（含用户手动取消关联的情况），不再重复打扰
    if (meta?.autoLyricSearched) return NOT_LINKED;

    pendingKeys.add(key);
    try {
        const { items, hasError } = await searchCandidates(query);
        if (isStale()) return NOT_LINKED;

        const ranked = pickCandidates(musicItem, items);
        if (ranked.length === 0) {
            // 搜索链路正常但确实没有匹配项 → 标记为已搜索，避免反复空搜；
            // 若插件调用出错（可能是网络抖动），不标记，保留下次重试机会
            if (!hasError) {
                await mediaMeta.setMeta(platform, musicId, { autoLyricSearched: true });
            }
            return NOT_LINKED;
        }

        // 按得分顺位尝试：某候选取歌词失败或内容为空时，尝试下一个
        for (const { item } of ranked) {
            let lyricSource: ILyric.ILyricSource | null = null;
            try {
                lyricSource = await pluginManager.callPluginMethod({
                    platform: item.platform,
                    method: 'getLyric',
                    args: [item],
                });
            } catch {
                // 当前候选获取失败，顺位尝试下一个
            }
            if (isStale()) return NOT_LINKED;
            if (!lyricSource?.rawLrc && !lyricSource?.translation) continue;

            // 与手动关联保持一致：仅有翻译时把翻译提升为原文
            const rawLrc = lyricSource.rawLrc ?? lyricSource.translation;
            const translation = lyricSource.rawLrc ? lyricSource.translation : undefined;

            await mediaMeta.setMeta(platform, musicId, {
                associatedLyric: { musicItem: item, rawLrc, translation },
                autoLyricSearched: true,
            });

            if (isStale()) return NOT_LINKED;

            return { linked: true, matched: item };
        }

        // 全部候选都拿不到歌词：链路正常则视为"没有可用结果"，不再重试
        if (!hasError) {
            await mediaMeta.setMeta(platform, musicId, { autoLyricSearched: true });
        }
        return NOT_LINKED;
    } catch {
        // 自动搜索属于增强能力，任何异常都不应影响正常播放
        return NOT_LINKED;
    } finally {
        pendingKeys.delete(key);
    }
}
