/**
 * LyricManager — 歌词获取 & 逐行追踪
 *
 * 通过 pluginManager 获取歌词源，使用 LyricParser 解析，
 * 播放进度变化时更新当前歌词行并写入 jotai atom。
 * 常规途径全部拿不到歌词时，交由 autoLyricSearch 自动搜索关联。
 */
import LyricParser from '@common/lyricParser';
import { compositeKey } from '@common/mediaKey';
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import i18n from '@infra/i18n/renderer';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { store, currentLyricAtom, progressAtom, associatedLyricAtom } from './store';
import { autoSearchLyric } from './autoLyricSearch';

/** 歌词偏移写入 mediaMeta 的防抖延迟（ms） */
const OFFSET_PERSIST_DELAY = 500;

class LyricManager {
    private parser: LyricParser | null = null;
    private currentMusicKey: string | null = null;
    /** 当前歌曲的 platform + musicId，用于写入 mediaMeta */
    private currentPlatform: string | null = null;
    private currentMusicId: string | null = null;
    /** 用户调整的歌词偏移（秒），正值表示歌词提前，负值表示歌词延后 */
    private userOffset = 0;
    /** 防抖写入 mediaMeta 的定时器 */
    private persistTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    /** 获取并解析歌词 */
    async fetchLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        const key = compositeKey(musicItem.platform, musicItem.id);
        this.currentMusicKey = key;
        this.currentPlatform = musicItem.platform;
        this.currentMusicId = String(musicItem.id);

        // 从 mediaMeta 恢复该歌曲的歌词偏移和关联歌词信息
        const meta = await mediaMeta.getMeta(musicItem.platform, String(musicItem.id));
        this.userOffset = meta?.lyricOffset ?? 0;
        store.set(associatedLyricAtom, meta?.associatedLyric?.musicItem ?? null);

        try {
            const lyricSource = await pluginManager.adapters.getLyric(musicItem);

            // 切歌了，丢弃旧结果
            if (this.currentMusicKey !== key) return;

            if (!lyricSource?.rawLrc && !lyricSource?.lrc) {
                this.parser = null;
                store.set(currentLyricAtom, null);
                // 全部获取途径都没有歌词，尝试自动搜索关联
                await this.tryAutoSearch(musicItem, key);
                return;
            }

            this.applyLyricSource(musicItem, lyricSource);
        } catch {
            if (this.currentMusicKey === key) {
                this.parser = null;
                store.set(currentLyricAtom, null);
            }
        }
    }

    /** 根据播放进度更新当前歌词行 */
    updatePosition(currentTime: number): void {
        if (!this.parser) return;

        const lyricItem = this.parser.getPosition(currentTime + this.userOffset);
        const prev = store.get(currentLyricAtom);

        if (prev?.currentLrc?.index !== lyricItem?.index) {
            store.set(currentLyricAtom, {
                parser: this.parser,
                currentLrc: lyricItem ?? undefined,
            });
        }
    }

    /** 重置 */
    reset(): void {
        this.parser = null;
        this.currentMusicKey = null;
        this.currentPlatform = null;
        this.currentMusicId = null;
        this.userOffset = 0;
        clearTimeout(this.persistTimer);
        store.set(currentLyricAtom, null);
        store.set(associatedLyricAtom, null);
    }

    /** 获取当前用户歌词偏移（秒） */
    getUserOffset(): number {
        return this.userOffset;
    }

    /** 设置用户歌词偏移（秒），并立即刷新当前歌词行 */
    setUserOffset(offset: number): void {
        this.userOffset = offset;
        const currentTime = store.get(progressAtom).currentTime;
        this.updatePosition(currentTime);

        // 防抖写入 mediaMeta
        clearTimeout(this.persistTimer);
        const platform = this.currentPlatform;
        const musicId = this.currentMusicId;
        if (platform && musicId) {
            this.persistTimer = setTimeout(() => {
                // 确保写入时仍是同一首歌
                if (this.currentPlatform !== platform || this.currentMusicId !== musicId) return;
                if (offset === 0) {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: null });
                } else {
                    mediaMeta.setMeta(platform, musicId, { lyricOffset: offset });
                }
            }, OFFSET_PERSIST_DELAY);
        }
    }

    /** 强制重新加载当前歌曲歌词（用于关联/取消关联歌词后刷新） */
    async refreshLyric(musicItem: IMusic.IMusicItem): Promise<void> {
        // 清除当前歌词状态，让 fetchLyric 重新加载
        this.parser = null;
        this.currentMusicKey = null;
        store.set(currentLyricAtom, null);
        await this.fetchLyric(musicItem);
    }

    /** 用歌词源构建解析器并定位到当前播放进度 */
    private applyLyricSource(musicItem: IMusic.IMusicItem, lyricSource: ILyric.ILyricSource) {
        this.parser = new LyricParser(lyricSource.rawLrc ?? lyricSource.lrc ?? '', {
            musicItem,
            translation: lyricSource.translation,
        });

        // C-17: 初始定位到当前播放时间（恢复播放等场景，避免歌词从头开始）
        const currentTime = store.get(progressAtom).currentTime;
        store.set(currentLyricAtom, {
            parser: this.parser,
            currentLrc: this.parser.getPosition(currentTime + this.userOffset) ?? undefined,
        });
    }

    /**
     * 常规途径拿不到歌词时，自动搜索并关联。
     *
     * 关联成功后重新读取歌词源（此时命中 getLyricAdapter 的"用户关联歌词"分支），
     * 并同步 associatedLyricAtom，让界面显示歌词来源。
     */
    private async tryAutoSearch(musicItem: IMusic.IMusicItem, key: string): Promise<void> {
        try {
            const result = await autoSearchLyric(musicItem, () => this.currentMusicKey !== key);
            // 切歌了，丢弃结果
            if (!result.linked || this.currentMusicKey !== key) return;

            store.set(associatedLyricAtom, result.matched ?? null);

            const lyricSource = await pluginManager.adapters.getLyric(musicItem);
            if (this.currentMusicKey !== key) return;

            if (lyricSource?.rawLrc || lyricSource?.lrc) {
                this.applyLyricSource(musicItem, lyricSource);
                if (result.matched) {
                    showToast(
                        i18n.t('lyric.auto_linked', {
                            platform: result.matched.platform ?? '',
                            title: result.matched.title ?? '',
                        }),
                    );
                }
            }
        } catch {
            // 自动搜索失败不影响播放，保持"暂无歌词"状态
        }
    }
}

export default LyricManager;
