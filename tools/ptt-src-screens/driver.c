// 用 upstream pttbbs 原始碼產生畫面位元組（不架站、不登入）：連結 mbbsd 的物件檔
// （main 改名成 ptt_main），自己假造 SHM／使用者狀態，從指定入口直接呼叫 upstream 的
// 畫面函式，畫面由 upstream 自己的 readdoent／psb／pfterm 畫出來，寫到 stdout。
// 按鍵從 stdin 進來（capture.mjs 等到 WAIT_MARK 才送下一個鍵）。
//
// 用法：driver <bbshome 絕對路徑> <seed 檔絕對路徑> <入口> [列數]
// 入口：
//   read:<板名>  enter_board＋Read()（文章列表；看板有進板畫面就先畫進板畫面）
//   fav          我的最愛（Favorite()，內容＝seed 的 F 列）
//   menu         主功能表（main_menu()）
//   menu:newmail 同上，但有新信（ALERT_NEW_MAIL）
//   wmsg:<模式>  先收下 seed 的 W 列水球（write_request），再進主功能表；模式 default＝一般
//                水球、ofo＝一對一（UF_PAGER_OFO）。之後送 ^R 就是 upstream 的回水球畫面。
// seed 檔（Big5，tab 分隔）：
//   B <brdname> <class> <desc> <BM> [flags] [parent]      開一個看板（之後的 A／N 屬於它）；
//                                                         flags G＝群組，parent＝所屬群組板名
//   A <owner> <date> <recommend> <flags> <title>          一篇文章；flags: m=marked b=置底 g=收入文摘
//   G <count> <owner> <title>                             批次 count 篇「<title> <i>」（無內文）
//   N <text>                                              一列進板畫面（notes）
//   T <text>                                              接在上一個 A 的文章檔尾的一列（原樣）
//   E <owner> <title>                                     看板精華區的一個檔案項目
//   F <brdname>                                           加進我的最愛
//   L <owner> <date> <title>                              tester 信箱裡的一封信（內文 body；T 列接在它的檔尾）
//   W <userid> <text>                                     一顆水球（依序收，只有 wmsg 入口用）
#include "bbs.h"
#include <poll.h>
#include <sys/select.h>
#include <unistd.h>
#include <utime.h>

int ptt_main(int argc, char *argv[], char *envp[]);

static void die(const char *m) { fprintf(stderr, "driver: %s\n", m); exit(2); }

// 幀尾：upstream 要阻塞等 stdin（＝這一幀畫完、pfterm 已 flush）時，在 stdout 寫 WAIT_MARK，
// capture.mjs 收到它才切幀、送下一個鍵；沒等到它就結束＝失敗。以前靠「多久沒輸出」猜，機器忙時
// 會切出半幀、或把還沒死透的 die() 當成功。APC 字串 pfterm 不會吐；capture.mjs 的 WAIT_MARK 要同一串。
// generate.sh 以 -Wl,--wrap=read,--wrap=select,--wrap=poll 連結：igetch.c 直接 read(0)，
// 有 attached_fd 時先 select(NULL)，nios.c 則 poll(INFTIM)；三條都經過這裡。
// 只在「真的會阻塞」時寫：stdin 已有資料（typeahead／prefetch）或有逾時的等待都不是幀尾。
#define WAIT_MARK "\x1b_ptt-src-screens:wait\x1b\\"
int __real_poll(struct pollfd *fds, nfds_t n, int timeout);
ssize_t __real_read(int fd, void *buf, size_t n);
int __real_select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *tv);

static void mark_wait(void)
{
    struct pollfd p = { .fd = 0, .events = POLLIN };
    if (__real_poll(&p, 1, 0) > 0)
        return;
    if (write(1, WAIT_MARK, sizeof(WAIT_MARK) - 1) < 0)
        die("write wait mark");
}

ssize_t __wrap_read(int fd, void *buf, size_t n)
{
    if (fd == 0)
        mark_wait();
    return __real_read(fd, buf, n);
}

int __wrap_select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *tv)
{
    if (!tv && r && n > 0 && FD_ISSET(0, r))
        mark_wait();
    return __real_select(n, r, w, e, tv);
}

int __wrap_poll(struct pollfd *fds, nfds_t n, int timeout)
{
    if (timeout < 0)
        for (nfds_t i = 0; i < n; i++)
            if (fds[i].fd == 0 && (fds[i].events & POLLIN)) {
                mark_wait();
                break;
            }
    return __real_poll(fds, n, timeout);
}

// 板主：upstream 653523c 起 boardheader_t 的 BM 字串改成 moderators[]（使用者編號），畫面由
// cache.c#board_format_moderators 換回 id：先 passwd_query（沒有 .PASSWDS 就 exit(1)），
// 查不到且 firstlogin＝0 才退回 getuserid（SHM->userid）。driver 不造 .PASSWDS ⇒ 以
// --wrap=passwd_query 一律回「查不到」，id 寫在 SHM->userid。新舊 upstream 都要編得過：
// generate.sh 看 header 有沒有 moderators[] 決定 BH_MODERATORS。
int __wrap_passwd_query(int num, userec_t *buf)
{
    (void)num;
    (void)buf;
    return -1;
}

static void set_moderators(boardheader_t *bh, const char *bms)
{
#if BH_MODERATORS
    char tmp[IDLEN * 3 + 3];
    STRLCPY(tmp, bms);
    int m = 0;
    for (char *save = NULL, *id = strtok_r(tmp, "/", &save); id && m < MAX_BMs;
         id = strtok_r(NULL, "/", &save)) {
        int uid = 0;
        for (int i = 0; i < MAX_USERS && SHM->userid[i][0]; i++)
            if (!strcasecmp(SHM->userid[i], id)) uid = i + 1;
        if (!uid) {
            int i = 0;
            while (i < MAX_USERS && SHM->userid[i][0]) i++;
            if (i == MAX_USERS) die("userid full");
            STRLCPY(SHM->userid[i], id);
            uid = i + 1;
        }
        bh->moderators[m].unum = uid;
        bh->moderators[m].firstlogin = 0;
        m++;
    }
#else
    STRLCPY(bh->BM, bms);
#endif
}

// 輸出要可重現（fixture 進 repo，有 diff＝upstream 改了畫面）：時間釘死。
// 執行檔自己定義的 time() 會蓋過 libc 的（動態連結的符號解析先找執行檔）。
#define FIXED_NOW 1790500000 /* 2026-09-27 (UTC) */
time_t time(time_t *t)
{
    if (t)
        *t = FIXED_NOW;
    return FIXED_NOW;
}

#define MAX_FAV 16
static char fav_names[MAX_FAV][IDLEN + 1];
static int fav_count = 0;

// 水球只在 wmsg 入口才送進 currutmp：其他場景的畫面不能被它改到（fixture 要逐位元組不變）。
#define MAX_WB MAX_MSGS
static char wb_from[MAX_WB][IDLEN + 1];
static char wb_text[MAX_WB][76];
static int wb_count = 0;

// 寄件人各佔一個 SHM->uinfo（在線），訊息照 common/bbs/message.c#write_message_full 填進
// currutmp->msgs —— 不直接呼叫它：它會對收件人（＝自己）送 SIGUSR2。
static void inject_waterballs(void)
{
    int users = 0;
    for (int i = 0; i < wb_count; i++) {
        int slot = 0;
        for (int u = 1; u <= users; u++)
            if (strcmp(SHM->uinfo[u].userid, wb_from[i]) == 0)
                slot = u;
        if (!slot) {
            slot = ++users;
            userinfo_t *u = &SHM->uinfo[slot];
            STRLCPY(u->userid, wb_from[i]);
            u->pid = 10000 + slot;
            u->pager = PAGER_ON;
        }
        msgque_t *m = &currutmp->msgs[i];
        m->pid = SHM->uinfo[slot].pid;
        STRLCPY(m->userid, wb_from[i]);
        m->msgmode = MSGMODE_WRITE;
        STRLCPY(m->last_call_in, wb_text[i]);
        m->uslot = slot;
        currutmp->msgcount = i + 1;
    }
}

static void seed(const char *path)
{
    FILE *fp = fopen(path, "r");
    if (!fp) die("seed open");
    char line[1024], dir[PATHLEN];
    int bid = 0;
    char bname[IDLEN + 1] = "";
    int serial = 0, bottoms = 0;
    char last_article[PATHLEN] = ""; // T 列接在這篇的檔尾
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
            set_moderators(bh, f[4]);
            bh->nuser = 42;
            // 分類看板：G＝群組（目錄，BRD_GROUPBOARD）；parent＝所屬群組（gid，
            // cache.c#resolve_board_group 依它串子清單）。主功能表 C 的根是 bid 1。
            if (n >= 6 && strchr(f[5], 'G'))
                bh->brdattr |= BRD_GROUPBOARD;
            if (n >= 7 && f[6][0]) {
                for (int i = 0; i < bid; i++)
                    if (!strcasecmp(SHM->bcache[i].brdname, f[6]))
                        bh->gid = i + 1;
                if (!bh->gid) die("parent before B");
            }
            bid++;
            SHM->Bnumber = bid;
            bottoms = 0;
            STRLCPY(bname, f[1]);
            setbpath(dir, bname);
            char cmd[PATHLEN * 2];
            snprintf(cmd, sizeof(cmd), "mkdir -p %s", dir);
            if (system(cmd)) die("mkdir");
            // 沒有 .DIR 的看板 enter_board 會失敗：先建一個空的。
            setbdir(dir, bname);
            FILE *df = fopen(dir, "a");
            if (!df) die("touch .DIR");
            fclose(df);
        } else if (f[0][0] == 'G' && n >= 4) {
            // 批次產生 <count> 篇「<title> <i>」：填滿高終端的一頁用。
            if (!bid) die("G before B");
            int count = atoi(f[1]);
            for (int i = 1; i <= count; i++) {
                fileheader_t fh;
                memset(&fh, 0, sizeof(fh));
                snprintf(fh.filename, sizeof(fh.filename), "M.%d.A.%03X", 1790000000 + serial, serial);
                serial++;
                STRLCPY(fh.owner, f[2]);
                STRLCPY(fh.date, "10/01");
                snprintf(fh.title, sizeof(fh.title), "%s %d", f[3], i);
                setbdir(dir, bname);
                if (append_record(dir, &fh, sizeof(fh)) < 0) die("append_record");
            }
        } else if (f[0][0] == 'A' && n >= 6) {
            if (!bid) die("A before B");
            fileheader_t fh;
            memset(&fh, 0, sizeof(fh));
            snprintf(fh.filename, sizeof(fh.filename), "M.%d.A.%03X", 1790000000 + serial, serial);
            serial++;
            STRLCPY(fh.owner, f[1]);
            STRLCPY(fh.date, f[2]);
            fh.FH_RATING = atoi(f[3]); // generate.sh 依 header 給 rating（新）或 recommend（舊）
            if (strchr(f[4], 'm')) fh.filemode |= FILE_MARKED;
            STRLCPY(fh.title, f[5]);
            // 置底：upstream 的置底是 boardheader_t.bottom[] 裡的 AID 參照（指回 .DIR 裡
            // 掛 FILE_BOTTOM 的原文，common/bbs/cache.c#resolve_board_bottoms），列表尾端
            // 另外畫一列 ★。舊版另存 .DIR.bottom 副本的做法已移除。
            if (strchr(f[4], 'b')) {
                if (bottoms >= MAX_BOTTOM_POSTS) die("too many bottoms");
                fh.filemode |= FILE_BOTTOM;
                SHM->bcache[bid - 1].bottom[bottoms++] = fn2aidu(fh.filename);
            }
            char fpath[PATHLEN];
            setbfile(fpath, bname, fh.filename);
            FILE *af = fopen(fpath, "w");
            if (af) {
                // pmore 認的檔頭（作者／看板、標題、時間）＋本文。標題／時間是 Big5 跳脫
                // （本檔是 UTF-8；字串拆開寫，免得 \xc3 吃掉後面的 D）。
                fprintf(af, STR_AUTHOR1 " %s (%s) " STR_POST1 " %s\n", fh.owner, fh.owner, bname);
                fprintf(af, "\xbc\xd0\xc3" "D: %s\n", fh.title);
                fprintf(af, "\xae\xc9\xb6\xa1: Sun Sep 27 12:00:00 2026\n");
                fprintf(af, "\nbody\n");
                fclose(af);
            }
            STRLCPY(last_article, fpath);
            // 收入文摘：同 bbs.c#good_post——檔名首字換成 G 複製一份、filemode 清零後
            // append 到看板的 fn_mandex（文摘模式的 .DIR，stuff.c#setbdir），原文掛 FILE_DIGEST。
            if (strchr(f[4], 'g')) {
                fileheader_t digest = fh;
                digest.filename[0] = 'G';
                digest.filemode = 0;
                char gpath[PATHLEN];
                setbfile(gpath, bname, digest.filename);
                if (Copy(fpath, gpath) < 0) die("digest copy");
                setbfile(dir, bname, fn_mandex);
                if (append_record(dir, &digest, sizeof(digest)) < 0) die("append_record digest");
                fh.filemode |= FILE_DIGEST;
            }
            setbdir(dir, bname);
            if (append_record(dir, &fh, sizeof(fh)) < 0) die("append_record");
        } else if (f[0][0] == 'E' && n >= 3) {
            // 精華區一個檔案項目（man/boards/<c>/<板>/.DIR，bbs.c#b_man 的 setapath）。
            // 標題照 a_copyitem 的慣例帶「◇ 」前綴，寫在 seed 裡。
            if (!bid) die("E before B");
            char apath[PATHLEN], fpath[PATHLEN], cmd[PATHLEN * 2];
            setapath(apath, bname);
            snprintf(cmd, sizeof(cmd), "mkdir -p %s", apath);
            if (system(cmd)) die("mkdir man");
            fileheader_t fh;
            memset(&fh, 0, sizeof(fh));
            snprintf(fh.filename, sizeof(fh.filename), "M.%d.A.%03X", 1790000000 + serial, serial);
            serial++;
            STRLCPY(fh.owner, f[1]);
            STRLCPY(fh.title, f[2]);
            snprintf(fpath, sizeof(fpath), "%s/%s", apath, fh.filename);
            FILE *ef = fopen(fpath, "w");
            if (!ef) die("man file");
            fprintf(ef, STR_AUTHOR1 " %s (%s) " STR_POST1 " %s\n", fh.owner, fh.owner, bname);
            fprintf(ef, "\xbc\xd0\xc3" "D: %s\n", fh.title);
            fprintf(ef, "\xae\xc9\xb6\xa1: Sun Sep 27 12:00:00 2026\n");
            fprintf(ef, "\nbody\n");
            fclose(ef);
            // 精華區列表的日期欄是檔案 mtime（announce.c 的 dasht → a_timestamp），不釘死的話
            // fixture 每天都不一樣。
            struct utimbuf ut = { FIXED_NOW, FIXED_NOW };
            if (utime(fpath, &ut) < 0) die("utime man");
            snprintf(dir, sizeof(dir), "%s/" FN_DIR, apath);
            if (append_record(dir, &fh, sizeof(fh)) < 0) die("append_record man");
        } else if (f[0][0] == 'N' && n >= 2) {
            if (!bid) die("N before B");
            char fpath[PATHLEN];
            setbfile(fpath, bname, fn_notes);
            FILE *nf = fopen(fpath, "a");
            if (!nf) die("notes open");
            fprintf(nf, "%s\n", f[1]);
            fclose(nf);
            // Read() 只在 bupdate 非 0 時畫進板畫面（bbs.c#Read 的 board_note_time）。
            SHM->bcache[bid - 1].bupdate = FIXED_NOW;
        } else if (f[0][0] == 'T' && n >= 2) {
            // 文章檔尾的一列（原樣，含行首空白）：發信站「※ 」列與 post.svc 的新格式推文
            // （"[N] id creation"＋"  內容"）。pmore 從最後一個「※ 」列之後畫成推文。
            if (!last_article[0]) die("T before A");
            FILE *tf = fopen(last_article, "a");
            if (!tf) die("article append");
            fprintf(tf, "%s\n", f[1]);
            fclose(tf);
        } else if (f[0][0] == 'F' && n >= 2) {
            if (fav_count >= MAX_FAV) die("too many favs");
            STRLCPY(fav_names[fav_count], f[1]);
            fav_count++;
        } else if (f[0][0] == 'L' && n >= 4) {
            // 一封信（tester 的信箱 .DIR＋信件內容，mail.c#mail_read 用 more() 開）。
            fileheader_t fh;
            memset(&fh, 0, sizeof(fh));
            snprintf(fh.filename, sizeof(fh.filename), "M.%d.A.%03X", 1790000000 + serial, serial);
            serial++;
            STRLCPY(fh.owner, f[1]);
            STRLCPY(fh.date, f[2]);
            STRLCPY(fh.title, f[3]);
            char mpath[PATHLEN];
            sethomefile(mpath, "tester", fh.filename);
            FILE *mf = fopen(mpath, "w");
            if (!mf) die("mail file");
            // 站內信的檔頭（edit.c#write_header 的寄信分支：作者／標題／時間，沒有看板欄）。
            fprintf(mf, STR_AUTHOR1 " %s (%s)\n", fh.owner, fh.owner);
            fprintf(mf, "\xbc\xd0\xc3" "D: %s\n", fh.title);
            fprintf(mf, "\xae\xc9\xb6\xa1: Sun Sep 27 12:00:00 2026\n");
            fprintf(mf, "\nbody\n");
            fclose(mf);
            STRLCPY(last_article, mpath);
            sethomedir(dir, "tester");
            if (append_record(dir, &fh, sizeof(fh)) < 0) die("append_record mail");
        } else if (f[0][0] == 'W' && n >= 3) {
            if (wb_count >= MAX_WB) die("too many waterballs");
            STRLCPY(wb_from[wb_count], f[1]);
            STRLCPY(wb_text[wb_count], f[2]);
            wb_count++;
        }
    }
    fclose(fp);
    // getbnum 對 bsorted 做二分搜尋：用 upstream 自己的排序（板名／分類兩份）。
    sort_bcache();
    for (int i = 1; i <= bid; i++)
        setbtotal(i);
}

int main(int argc, char *argv[])
{
    if (argc < 4) die("usage: driver <bbshome> <seed> <entry> [rows]");
    int rows = argc >= 5 ? atoi(argv[4]) : 24;
    if (rows < 24) die("rows");
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
    pwcuser.userlevel = PERM_BASIC | PERM_CHAT | PERM_PAGE | PERM_POST | PERM_LOGINOK | PERM_READMAIL;
    // 登入流程走完的旗標（mbbsd.c#user_login 最後才設）：Ctrl+Z 快速切換（menu.c#ZA_Select）、
    // Ctrl+U 等全域鍵沒有它一律不理。
    is_login_ready = 1;
    currutmp->pid = getpid();
    now = FIXED_NOW;
    login_start_time = FIXED_NOW;

    char home[PATHLEN];
    sethomepath(home, "tester");
    char cmd[PATHLEN * 2];
    snprintf(cmd, sizeof(cmd), "mkdir -p %s", home);
    if (system(cmd)) die("mkdir home");

    seed(argv[2]);

    // init_io 沒叫的話 pfterm 的輸出緩衝不存在，什麼都不會寫出來。
    init_io();
#if HAS_IPC_FD
    // upstream acee9aa 起等鍵也等 IPC service 的 fd；沒連上時改成每 2～3 秒醒來重連（有逾時的等待），
    // WAIT_MARK 永遠不出現。掛一個永遠不會可讀的 pipe 當 IPC fd ⇒ 回到無限期等待（select(NULL)／poll(INFTIM)）。
    // generate.sh 看 header 有沒有 vkey_attach_ipc 決定 HAS_IPC_FD。
    int ipc_pipe[2];
    if (pipe(ipc_pipe)) die("ipc pipe");
    vkey_attach_ipc(ipc_pipe[0]);
#endif
    term_init();
    term_set_size(80, rows);
    initscr();

    const char *entry = argv[3];
    if (strncmp(entry, "read:", 5) == 0) {
        // currboard 先清空：brc_initial_board 看到同名會走捷徑、不設 currbid。
        currboard = "";
        if (enter_board(entry + 5) < 0) die("enter_board");
        Read();
    } else if (strcmp(entry, "fav") == 0) {
        fav_load();
        for (int i = 0; i < fav_count; i++) {
            int bid = getbnum(fav_names[i]);
            if (bid <= 0) die("fav board");
            fav_add_board(bid);
        }
        Favorite();
    } else if (strcmp(entry, "menu") == 0) {
        main_menu();
    } else if (strcmp(entry, "menu:newmail") == 0) {
        // 有新信：menu.c#redraw_title 看 ISNEWMAIL 把標題列中段換成「你有新信件」。
        currutmp->alerts |= ALERT_NEW_MAIL;
        main_menu();
    } else if (strncmp(entry, "wmsg:", 5) == 0) {
        if (strcmp(entry + 5, "ofo") == 0)
            pwcuser.uflag |= UF_PAGER_OFO;
        else if (strcmp(entry + 5, "default") != 0)
            die("wmsg mode");
        currutmp->pager = PAGER_ON;
        inject_waterballs();
        write_request(0);
        main_menu();
    } else {
        die("entry");
    }
    oflush();
    return 0;
}
