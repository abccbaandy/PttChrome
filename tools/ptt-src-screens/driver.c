// 用 upstream pttbbs 原始碼產生畫面位元組（不架站、不登入）：連結 mbbsd 的物件檔
// （main 改名成 ptt_main），自己假造 SHM／使用者狀態，在種子看板上直接呼叫 Read()，
// 畫面由 upstream 自己的 readdoent／VCOL／pfterm 畫出來，寫到 stdout。
// 用法：driver <bbshome 絕對路徑> <seed 檔絕對路徑> < keys > screen.bin
// seed 檔（Big5，tab 分隔）：
//   B <brdname> <class> <desc> <BM>
//   A <owner> <date> <recommend> <flags: m=marked b=bottom> <title>
#include "bbs.h"

int ptt_main(int argc, char *argv[], char *envp[]);

static void die(const char *m) { fprintf(stderr, "driver: %s\n", m); exit(2); }

static void seed(const char *path)
{
    FILE *fp = fopen(path, "r");
    if (!fp) die("seed open");
    char line[1024], dir[PATHLEN];
    int bid = 0;
    char bname[IDLEN + 1] = "";
    int serial = 0;
    while (fgets(line, sizeof(line), fp)) {
        line[strcspn(line, "\n")] = 0;
        char *f[8] = {0};
        int n = 0;
        for (char *p = line; n < 8; ) {
            f[n++] = p;
            char *t = strchr(p, '\t');
            if (!t) break;
            *t = 0;
            p = t + 1;
        }
        if (f[0][0] == 'B' && n >= 5) {
            boardheader_t *bh = &SHM->bcache[bid];
            memset(bh, 0, sizeof(*bh));
            STRLCPY(bh->brdname, f[1]);
            STRLCPY(bh->bclass, f[2]);
            STRLCPY(bh->desc, f[3]);
            STRLCPY(bh->BM, f[4]);
            bh->nuser = 42;
            SHM->bsorted[0][bid] = bid;
            SHM->bsorted[1][bid] = bid;
            bid++;
            SHM->Bnumber = bid;
            STRLCPY(bname, f[1]);
            setbpath(dir, bname);
            char cmd[PATHLEN * 2];
            snprintf(cmd, sizeof(cmd), "mkdir -p %s", dir);
            if (system(cmd)) die("mkdir");
        } else if (f[0][0] == 'A' && n >= 6) {
            fileheader_t fh;
            memset(&fh, 0, sizeof(fh));
            snprintf(fh.filename, sizeof(fh.filename), "M.%d.A.%03X", 1790000000 + serial, serial);
            serial++;
            STRLCPY(fh.owner, f[1]);
            STRLCPY(fh.date, f[2]);
            fh.recommend = atoi(f[3]);
            if (strchr(f[4], 'm')) fh.filemode |= FILE_MARKED;
            if (strchr(f[4], 'b')) fh.filemode |= FILE_BOTTOM;
            STRLCPY(fh.title, f[5]);
            char fpath[PATHLEN];
            setbfile(fpath, bname, fh.filename);
            FILE *af = fopen(fpath, "w");
            if (af) {
                fprintf(af, "body\n");
                fclose(af);
            }
            setbdir(dir, bname);
            if (append_record(dir, &fh, sizeof(fh)) < 0) die("append_record");
        }
    }
    fclose(fp);
}

int main(int argc, char *argv[])
{
    if (argc < 3) die("usage");
    if (chdir(argv[1])) die("chdir");

    SHM = calloc(1, sizeof(SHM_t));
    if (!SHM) die("calloc");
    SHM->version = SHM_VERSION;
    SHM->size = sizeof(SHM_t);
    SHM->loaded = 1;
    SHM->Btouchtime = SHM->Ptouchtime = SHM->Ftouchtime = 1;
    bcache = SHM->bcache;

    currutmp = &SHM->uinfo[0];
    STRLCPY(pwcuser.userid, "tester");
    STRLCPY(currutmp->userid, "tester");
    pwcuser.userlevel = PERM_BASIC | PERM_CHAT | PERM_PAGE | PERM_POST | PERM_LOGINOK;
    currutmp->pid = getpid();

    seed(argv[2]);

    // init_io 沒叫的話 pfterm 的輸出緩衝不存在，什麼都不會寫出來。
    init_io();
    term_init();
    term_set_size(80, 24);
    initscr();
    // currboard 先清空：brc_initial_board 看到同名會走捷徑、不設 currbid。
    currboard = "";
    if (enter_board(SHM->bcache[0].brdname) < 0) die("enter_board");
    Read();
    oflush();
    return 0;
}
