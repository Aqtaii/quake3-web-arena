#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <setjmp.h>
#include <time.h>

#define WASM_IMPORT(module, name) __attribute__((import_module(module), import_name(name)))

/* JS Host Imports for VFS, Console, Time, Math, and Control Flow */
WASM_IMPORT("env", "js_console_print") extern void js_console_print(const char *str, int len);
WASM_IMPORT("env", "js_abort_frame") extern void js_abort_frame(int code);
WASM_IMPORT("env", "js_exit") extern void js_exit(int status);
WASM_IMPORT("env", "js_time_ms") extern int js_time_ms(void);
WASM_IMPORT("env", "js_time_sec") extern int js_time_sec(void);

WASM_IMPORT("env", "js_vfs_open") extern int js_vfs_open(const char *path, const char *mode);
WASM_IMPORT("env", "js_vfs_close") extern int js_vfs_close(int fd);
WASM_IMPORT("env", "js_vfs_read") extern int js_vfs_read(int fd, void *dst, int len);
WASM_IMPORT("env", "js_vfs_write") extern int js_vfs_write(int fd, const void *src, int len);
WASM_IMPORT("env", "js_vfs_seek") extern int js_vfs_seek(int fd, int offset, int whence);
WASM_IMPORT("env", "js_vfs_tell") extern int js_vfs_tell(int fd);
WASM_IMPORT("env", "js_vfs_eof") extern int js_vfs_eof(int fd);
WASM_IMPORT("env", "js_vfs_remove") extern int js_vfs_remove(const char *path);

WASM_IMPORT("env", "js_sin") extern double js_sin(double x);
WASM_IMPORT("env", "js_cos") extern double js_cos(double x);
WASM_IMPORT("env", "js_tan") extern double js_tan(double x);
WASM_IMPORT("env", "js_asin") extern double js_asin(double x);
WASM_IMPORT("env", "js_acos") extern double js_acos(double x);
WASM_IMPORT("env", "js_atan") extern double js_atan(double x);
WASM_IMPORT("env", "js_atan2") extern double js_atan2(double y, double x);
WASM_IMPORT("env", "js_pow") extern double js_pow(double x, double y);
WASM_IMPORT("env", "js_exp") extern double js_exp(double x);
WASM_IMPORT("env", "js_log") extern double js_log(double x);

int errno = 0;

/* =========================================================================
 * Memory Allocator (Free-list with coalescing + Wasm memory.grow)
 * ========================================================================= */
extern unsigned char __heap_base;

typedef struct __attribute__((aligned(16))) MemBlock {
    size_t size; /* aligned payload size */
    int free;
    uint32_t magic;
    struct MemBlock *next;
    struct MemBlock *prev;
} MemBlock;

#define MEM_MAGIC 0x51334D42u
#define ALIGN16(x) (((x) + 15u) & ~15u)

static MemBlock *g_heap_head = NULL;
static uintptr_t g_heap_top = 0;

static int ensure_wasm_memory(uintptr_t needed_end) {
    size_t cur_pages = __builtin_wasm_memory_size(0);
    uintptr_t cur_bytes = (uintptr_t)cur_pages * 65536u;
    if (needed_end <= cur_bytes) {
        return 1;
    }
    uintptr_t diff = needed_end - cur_bytes;
    size_t add_pages = (size_t)((diff + 65535u) / 65536u);
    if (add_pages < 16) add_pages = 16; /* grow by at least 1MB */
    if (__builtin_wasm_memory_grow(0, add_pages) == (size_t)-1) {
        return 0;
    }
    return 1;
}

__attribute__((no_builtin))
void *malloc(size_t size) {
    if (size > SIZE_MAX - 15u) return NULL;
    if (size == 0) size = 16;
    size = ALIGN16(size);

    if (g_heap_top == 0) {
        g_heap_top = ALIGN16((uintptr_t)&__heap_base);
    }

    MemBlock *curr = g_heap_head;
    MemBlock *last = NULL;
    while (curr) {
        if (curr->free && curr->size >= size) {
            if (curr->size >= size + sizeof(MemBlock) + 32) {
                MemBlock *split = (MemBlock *)((uintptr_t)(curr + 1) + size);
                split->size = curr->size - size - sizeof(MemBlock);
                split->free = 1;
                split->magic = MEM_MAGIC;
                split->next = curr->next;
                split->prev = curr;
                if (curr->next) curr->next->prev = split;
                curr->next = split;
                curr->size = size;
            }
            curr->free = 0;
            return (void *)(curr + 1);
        }
        last = curr;
        curr = curr->next;
    }

    size_t total = sizeof(MemBlock) + size;
    if (size > SIZE_MAX - sizeof(MemBlock) || g_heap_top > UINTPTR_MAX - total) return NULL;
    if (!ensure_wasm_memory(g_heap_top + total)) {
        return NULL;
    }
    MemBlock *blk = (MemBlock *)g_heap_top;
    g_heap_top += total;
    blk->size = size;
    blk->free = 0;
    blk->magic = MEM_MAGIC;
    blk->next = NULL;
    blk->prev = last;
    if (last) {
        last->next = blk;
    } else {
        g_heap_head = blk;
    }
    return (void *)(blk + 1);
}

__attribute__((no_builtin))
void free(void *ptr) {
    if (!ptr) return;
    MemBlock *blk = ((MemBlock *)ptr) - 1;
    if (blk->magic != MEM_MAGIC) return;
    blk->free = 1;

    /* Coalesce with next */
    if (blk->next && blk->next->free &&
        (uintptr_t)(blk + 1) + blk->size == (uintptr_t)blk->next) {
        MemBlock *n = blk->next;
        blk->size += sizeof(MemBlock) + n->size;
        blk->next = n->next;
        if (n->next) n->next->prev = blk;
    }
    /* Coalesce with prev */
    if (blk->prev && blk->prev->free &&
        (uintptr_t)(blk->prev + 1) + blk->prev->size == (uintptr_t)blk) {
        MemBlock *p = blk->prev;
        p->size += sizeof(MemBlock) + blk->size;
        p->next = blk->next;
        if (blk->next) blk->next->prev = p;
    }
}

__attribute__((no_builtin))
void *calloc(size_t nmemb, size_t size) {
    if (size && nmemb > SIZE_MAX / size) return NULL;
    size_t total = nmemb * size;
    void *p = malloc(total);
    if (p) {
        memset(p, 0, total);
    }
    return p;
}

__attribute__((no_builtin))
void *realloc(void *ptr, size_t size) {
    if (!ptr) return malloc(size);
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    MemBlock *blk = ((MemBlock *)ptr) - 1;
    if (blk->magic != MEM_MAGIC) return NULL;
    if (blk->size >= size) return ptr;

    void *newp = malloc(size);
    if (newp) {
        memcpy(newp, ptr, blk->size);
        free(ptr);
    }
    return newp;
}

/* =========================================================================
 * Memory & String Operations
 * ========================================================================= */
__attribute__((no_builtin))
void *memcpy(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dest;
    const unsigned char *s = (const unsigned char *)src;
    while (n--) *d++ = *s++;
    return dest;
}

__attribute__((no_builtin))
void *memmove(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dest;
    const unsigned char *s = (const unsigned char *)src;
    if (d < s) {
        while (n--) *d++ = *s++;
    } else if (d > s) {
        d += n;
        s += n;
        while (n--) *--d = *--s;
    }
    return dest;
}

__attribute__((no_builtin))
void *memset(void *s, int c, size_t n) {
    unsigned char *p = (unsigned char *)s;
    unsigned char v = (unsigned char)c;
    while (n--) *p++ = v;
    return s;
}

__attribute__((no_builtin))
int memcmp(const void *s1, const void *s2, size_t n) {
    const unsigned char *p1 = (const unsigned char *)s1;
    const unsigned char *p2 = (const unsigned char *)s2;
    while (n--) {
        if (*p1 != *p2) return (int)*p1 - (int)*p2;
        p1++;
        p2++;
    }
    return 0;
}

__attribute__((no_builtin))
void *memchr(const void *s, int c, size_t n) {
    const unsigned char *p = (const unsigned char *)s;
    unsigned char v = (unsigned char)c;
    while (n--) {
        if (*p == v) return (void *)p;
        p++;
    }
    return NULL;
}

__attribute__((no_builtin))
size_t strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}

__attribute__((no_builtin))
char *strcpy(char *dest, const char *src) {
    char *d = dest;
    while ((*d++ = *src++) != '\0');
    return dest;
}

__attribute__((no_builtin))
char *strncpy(char *dest, const char *src, size_t n) {
    char *d = dest;
    while (n && (*d = *src) != '\0') {
        d++;
        src++;
        n--;
    }
    while (n--) *d++ = '\0';
    return dest;
}

__attribute__((no_builtin))
char *strcat(char *dest, const char *src) {
    char *d = dest;
    while (*d) d++;
    while ((*d++ = *src++) != '\0');
    return dest;
}

__attribute__((no_builtin))
char *strncat(char *dest, const char *src, size_t n) {
    char *d = dest;
    while (*d) d++;
    while (n-- && *src) *d++ = *src++;
    *d = '\0';
    return dest;
}

__attribute__((no_builtin))
int strcmp(const char *s1, const char *s2) {
    while (*s1 && (*s1 == *s2)) {
        s1++;
        s2++;
    }
    return (int)(unsigned char)*s1 - (int)(unsigned char)*s2;
}

__attribute__((no_builtin))
int strncmp(const char *s1, const char *s2, size_t n) {
    if (n == 0) return 0;
    while (--n && *s1 && (*s1 == *s2)) {
        s1++;
        s2++;
    }
    return (int)(unsigned char)*s1 - (int)(unsigned char)*s2;
}

int tolower(int c) {
    if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
    return c;
}

int toupper(int c) {
    if (c >= 'a' && c <= 'z') return c - ('a' - 'A');
    return c;
}

int strcasecmp(const char *s1, const char *s2) {
    int c1, c2;
    do {
        c1 = tolower((unsigned char)*s1++);
        c2 = tolower((unsigned char)*s2++);
    } while (c1 && (c1 == c2));
    return c1 - c2;
}

int strncasecmp(const char *s1, const char *s2, size_t n) {
    if (n == 0) return 0;
    int c1, c2;
    do {
        c1 = tolower((unsigned char)*s1++);
        c2 = tolower((unsigned char)*s2++);
        if (--n == 0) break;
    } while (c1 && (c1 == c2));
    return c1 - c2;
}

int stricmp(const char *s1, const char *s2) {
    return strcasecmp(s1, s2);
}

int strnicmp(const char *s1, const char *s2, size_t n) {
    return strncasecmp(s1, s2, n);
}

__attribute__((no_builtin))
char *strchr(const char *s, int c) {
    char ch = (char)c;
    while (*s) {
        if (*s == ch) return (char *)s;
        s++;
    }
    return (ch == '\0') ? (char *)s : NULL;
}

__attribute__((no_builtin))
char *strrchr(const char *s, int c) {
    const char *last = NULL;
    char ch = (char)c;
    while (*s) {
        if (*s == ch) last = s;
        s++;
    }
    return (ch == '\0') ? (char *)s : (char *)last;
}

__attribute__((no_builtin))
char *strstr(const char *haystack, const char *needle) {
    if (!*needle) return (char *)haystack;
    size_t nlen = strlen(needle);
    while (*haystack) {
        if (*haystack == *needle && strncmp(haystack, needle, nlen) == 0) {
            return (char *)haystack;
        }
        haystack++;
    }
    return NULL;
}

size_t strspn(const char *s, const char *accept) {
    const char *p = s;
    while (*p && strchr(accept, *p)) p++;
    return (size_t)(p - s);
}

size_t strcspn(const char *s, const char *reject) {
    const char *p = s;
    while (*p && !strchr(reject, *p)) p++;
    return (size_t)(p - s);
}

char *strpbrk(const char *s, const char *accept) {
    while (*s) {
        if (strchr(accept, *s)) return (char *)s;
        s++;
    }
    return NULL;
}

char *strtok(char *str, const char *delim) {
    static char *save = NULL;
    if (str) save = str;
    if (!save) return NULL;
    save += strspn(save, delim);
    if (!*save) {
        save = NULL;
        return NULL;
    }
    char *tok = save;
    save += strcspn(save, delim);
    if (*save) {
        *save++ = '\0';
    } else {
        save = NULL;
    }
    return tok;
}

char *strdup(const char *s) {
    size_t len = strlen(s) + 1;
    char *d = (char *)malloc(len);
    if (d) memcpy(d, s, len);
    return d;
}

char *strlwr(char *s) {
    if (!s) return NULL;
    char *p = s;
    while (*p) {
        *p = (char)tolower((unsigned char)*p);
        p++;
    }
    return s;
}

char *strerror(int errnum) {
    (void)errnum;
    return "errno";
}

/* =========================================================================
 * ctype.h
 * ========================================================================= */
int isspace(int c) { return (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'); }
int isdigit(int c) { return (c >= '0' && c <= '9'); }
int isalpha(int c) { return ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')); }
int isalnum(int c) { return isalpha(c) || isdigit(c); }
int isupper(int c) { return (c >= 'A' && c <= 'Z'); }
int islower(int c) { return (c >= 'a' && c <= 'z'); }
int isprint(int c) { return (c >= 0x20 && c <= 0x7e); }
int isgraph(int c) { return (c > 0x20 && c <= 0x7e); }
int iscntrl(int c) { return ((c >= 0 && c < 0x20) || c == 0x7f); }
int ispunct(int c) { return isgraph(c) && !isalnum(c); }
int isxdigit(int c) { return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

/* =========================================================================
 * stdlib.h conversions, rand, qsort
 * ========================================================================= */
int abs(int j) { return j < 0 ? -j : j; }
long labs(long j) { return j < 0 ? -j : j; }

long strtol(const char *nptr, char **endptr, int base) {
    const char *s = nptr;
    while (isspace((unsigned char)*s)) s++;
    int neg = 0;
    if (*s == '-') { neg = 1; s++; }
    else if (*s == '+') { s++; }

    if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
        s += 2;
        base = 16;
    } else if (base == 0) {
        base = (s[0] == '0') ? 8 : 10;
    }

    unsigned long acc = 0;
    int any = 0;
    while (*s) {
        int c = (unsigned char)*s;
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'Z') d = c - 'A' + 10;
        else break;
        if (d >= base) break;
        acc = acc * (unsigned long)base + (unsigned long)d;
        s++;
        any = 1;
    }
    if (endptr) *endptr = (char *)(any ? s : nptr);
    return neg ? -(long)acc : (long)acc;
}

unsigned long strtoul(const char *nptr, char **endptr, int base) {
    return (unsigned long)strtol(nptr, endptr, base);
}

int atoi(const char *nptr) {
    return (int)strtol(nptr, NULL, 10);
}

long atol(const char *nptr) {
    return strtol(nptr, NULL, 10);
}

double strtod(const char *nptr, char **endptr) {
    const char *s = nptr;
    while (isspace((unsigned char)*s)) s++;
    double sign = 1.0;
    if (*s == '-') { sign = -1.0; s++; }
    else if (*s == '+') { s++; }

    double val = 0.0;
    int any = 0;
    while (isdigit((unsigned char)*s)) {
        val = val * 10.0 + (*s - '0');
        s++;
        any = 1;
    }
    if (*s == '.') {
        s++;
        double frac = 0.1;
        while (isdigit((unsigned char)*s)) {
            val += (*s - '0') * frac;
            frac *= 0.1;
            s++;
            any = 1;
        }
    }
    if (any && (*s == 'e' || *s == 'E')) {
        s++;
        int esign = 1;
        if (*s == '-') { esign = -1; s++; }
        else if (*s == '+') { s++; }
        int exp = 0;
        while (isdigit((unsigned char)*s)) {
            exp = exp * 10 + (*s - '0');
            s++;
        }
        double p = 1.0;
        while (exp-- > 0) p *= 10.0;
        if (esign < 0) val /= p;
        else val *= p;
    }
    if (endptr) *endptr = (char *)(any ? s : nptr);
    return sign * val;
}

float strtof(const char *nptr, char **endptr) {
    return (float)strtod(nptr, endptr);
}

double atof(const char *nptr) {
    return strtod(nptr, NULL);
}

static unsigned int g_rand_seed = 1;
void srand(unsigned int seed) { g_rand_seed = seed; }
int rand(void) {
    g_rand_seed = g_rand_seed * 1103515245u + 12345u;
    return (int)((g_rand_seed >> 16) & 0x7fff);
}

void qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *)) {
    if (nmemb < 2 || size == 0) return;
    unsigned char *arr = (unsigned char *)base;
    unsigned char tmp[256];
    /* Shell sort (in-place, fast, no recursion or large stack needed) */
    for (size_t gap = nmemb / 2; gap > 0; gap /= 2) {
        for (size_t i = gap; i < nmemb; i++) {
            size_t j = i;
            while (j >= gap) {
                unsigned char *a = arr + (j - gap) * size;
                unsigned char *b = arr + j * size;
                if (compar(a, b) <= 0) break;
                size_t rem = size;
                unsigned char *pa = a;
                unsigned char *pb = b;
                while (rem > 0) {
                    size_t chunk = rem > sizeof(tmp) ? sizeof(tmp) : rem;
                    memcpy(tmp, pa, chunk);
                    memcpy(pa, pb, chunk);
                    memcpy(pb, tmp, chunk);
                    pa += chunk;
                    pb += chunk;
                    rem -= chunk;
                }
                j -= gap;
            }
        }
    }
}

void *bsearch(const void *key, const void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *)) {
    const unsigned char *arr = (const unsigned char *)base;
    size_t lo = 0, hi = nmemb;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const void *elem = arr + mid * size;
        int c = compar(key, elem);
        if (c == 0) return (void *)elem;
        if (c < 0) hi = mid;
        else lo = mid + 1;
    }
    return NULL;
}

char *getenv(const char *name) {
    (void)name;
    return NULL;
}

int putenv(char *string) {
    (void)string;
    return 0;
}

int system(const char *command) {
    (void)command;
    return -1;
}

void abort(void) {
    js_exit(1);
    __builtin_unreachable();
}

void exit(int status) {
    js_exit(status);
    __builtin_unreachable();
}

int atexit(void (*func)(void)) {
    (void)func;
    return 0;
}

void __wasm_assert_fail(const char *expr, const char *file, int line) {
    char buf[256];
    int n = snprintf(buf, sizeof(buf), "ASSERTION FAILED: %s (%s:%d)\n", expr, file, line);
    js_console_print(buf, n);
}

/* =========================================================================
 * setjmp / longjmp
 * ========================================================================= */
int setjmp(jmp_buf env) {
    (void)env;
    return 0;
}

void longjmp(jmp_buf env, int val) {
    (void)env;
    js_abort_frame(val ? val : 1);
    __builtin_unreachable();
}

/* =========================================================================
 * time.h
 * ========================================================================= */
time_t time(time_t *tloc) {
    time_t t = (time_t)js_time_sec();
    if (tloc) *tloc = t;
    return t;
}

clock_t clock(void) {
    return (clock_t)js_time_ms();
}

static struct tm g_tm;
struct tm *localtime(const time_t *timer) {
    time_t t = timer ? *timer : time(NULL);
    int sec = (int)(t % 86400);
    if (sec < 0) sec += 86400;
    g_tm.tm_sec = sec % 60;
    g_tm.tm_min = (sec / 60) % 60;
    g_tm.tm_hour = sec / 3600;
    g_tm.tm_mday = 16;
    g_tm.tm_mon = 9;
    g_tm.tm_year = 126;
    g_tm.tm_wday = 5;
    g_tm.tm_yday = 288;
    g_tm.tm_isdst = 0;
    return &g_tm;
}

struct tm *gmtime(const time_t *timer) {
    return localtime(timer);
}

static char g_ctime_buf[32];
char *asctime(const struct tm *tm) {
    snprintf(g_ctime_buf, sizeof(g_ctime_buf), "Fri Oct 16 %02d:%02d:%02d 2026\n",
             tm ? tm->tm_hour : 0, tm ? tm->tm_min : 0, tm ? tm->tm_sec : 0);
    return g_ctime_buf;
}

char *ctime(const time_t *timer) {
    return asctime(localtime(timer));
}

/* =========================================================================
 * Math Library
 * ========================================================================= */
double sin(double x) { return js_sin(x); }
double cos(double x) { return js_cos(x); }
double tan(double x) { return js_tan(x); }
double asin(double x) { return js_asin(x); }
double acos(double x) { return js_acos(x); }
double atan(double x) { return js_atan(x); }
double atan2(double y, double x) { return js_atan2(y, x); }
double pow(double x, double y) { return js_pow(x, y); }
double exp(double x) { return js_exp(x); }
double log(double x) { return js_log(x); }
double log10(double x) { return js_log(x) / 2.302585092994046; }

float sinf(float x) { return (float)js_sin((double)x); }
float cosf(float x) { return (float)js_cos((double)x); }
float tanf(float x) { return (float)js_tan((double)x); }
float asinf(float x) { return (float)js_asin((double)x); }
float acosf(float x) { return (float)js_acos((double)x); }
float atanf(float x) { return (float)js_atan((double)x); }
float atan2f(float y, float x) { return (float)js_atan2((double)y, (double)x); }
float powf(float x, float y) { return (float)js_pow((double)x, (double)y); }

double sqrt(double x) { return __builtin_sqrt(x); }
float sqrtf(float x) { return __builtin_sqrtf(x); }
double fabs(double x) { return __builtin_fabs(x); }
float fabsf(float x) { return __builtin_fabsf(x); }
double floor(double x) { return __builtin_floor(x); }
float floorf(float x) { return __builtin_floorf(x); }
double ceil(double x) { return __builtin_ceil(x); }
float ceilf(float x) { return __builtin_ceilf(x); }
double rint(double x) { return __builtin_rint(x); }
float rintf(float x) { return __builtin_rintf(x); }

double fmod(double x, double y) {
    if (y == 0.0) return 0.0;
    double q = (double)(long long)(x / y);
    return x - q * y;
}

float fmodf(float x, float y) {
    return (float)fmod((double)x, (double)y);
}

double ldexp(double x, int exp) {
    while (exp > 0) { x *= 2.0; exp--; }
    while (exp < 0) { x *= 0.5; exp++; }
    return x;
}

double frexp(double x, int *exp) {
    if (x == 0.0) {
        if (exp) *exp = 0;
        return 0.0;
    }
    int e = 0;
    double ax = fabs(x);
    while (ax >= 1.0) { ax *= 0.5; x *= 0.5; e++; }
    while (ax < 0.5) { ax *= 2.0; x *= 2.0; e--; }
    if (exp) *exp = e;
    return x;
}

double modf(double x, double *iptr) {
    double i = (x >= 0.0) ? floor(x) : ceil(x);
    if (iptr) *iptr = i;
    return x - i;
}

/* =========================================================================
 * Formatted Output (vsnprintf, snprintf, vsprintf, sprintf, printf)
 * ========================================================================= */
static void fmt_putc(char *buf, size_t size, size_t *idx, char c) {
    if (buf && *idx + 1 < size) {
        buf[*idx] = c;
    }
    (*idx)++;
}

int vsnprintf(char *str, size_t size, const char *format, va_list ap) {
    size_t idx = 0;
    const char *p = format;

    while (*p) {
        if (*p != '%') {
            fmt_putc(str, size, &idx, *p++);
            continue;
        }
        p++; /* skip '%' */
        if (*p == '%') {
            fmt_putc(str, size, &idx, *p++);
            continue;
        }

        int left_align = 0;
        int plus_sign = 0;
        int space_sign = 0;
        int zero_pad = 0;
        int alt_form = 0;

        for (;;) {
            if (*p == '-') left_align = 1;
            else if (*p == '+') plus_sign = 1;
            else if (*p == ' ') space_sign = 1;
            else if (*p == '0') zero_pad = 1;
            else if (*p == '#') alt_form = 1;
            else break;
            p++;
        }
        (void)alt_form;

        int width = 0;
        if (*p == '*') {
            width = va_arg(ap, int);
            if (width < 0) { left_align = 1; width = -width; }
            p++;
        } else {
            while (isdigit((unsigned char)*p)) {
                width = width * 10 + (*p - '0');
                p++;
            }
        }

        int prec = -1;
        if (*p == '.') {
            p++;
            prec = 0;
            if (*p == '*') {
                prec = va_arg(ap, int);
                p++;
            } else {
                while (isdigit((unsigned char)*p)) {
                    prec = prec * 10 + (*p - '0');
                    p++;
                }
            }
        }

        int length_mod = 0;
        while (*p == 'l' || *p == 'h' || *p == 'z') {
            length_mod = *p;
            p++;
        }
        (void)length_mod;

        char spec = *p ? *p++ : '\0';
        if (!spec) break;

        if (spec == 's') {
            const char *s = va_arg(ap, const char *);
            if (!s) s = "(null)";
            int slen = (int)strlen(s);
            if (prec >= 0 && prec < slen) slen = prec;
            int pad = width - slen;
            if (!left_align) {
                while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            }
            for (int i = 0; i < slen; i++) fmt_putc(str, size, &idx, s[i]);
            if (left_align) {
                while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            }
        } else if (spec == 'c') {
            char c = (char)va_arg(ap, int);
            int pad = width - 1;
            if (!left_align) while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            fmt_putc(str, size, &idx, c);
            if (left_align) while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
        } else if (spec == 'd' || spec == 'i' || spec == 'u' || spec == 'x' || spec == 'X' || spec == 'p' || spec == 'o') {
            unsigned long uval;
            int neg = 0;
            int base = 10;
            const char *digits = "0123456789abcdef";
            if (spec == 'd' || spec == 'i') {
                long sval = va_arg(ap, long);
                if (sval < 0) { neg = 1; uval = (unsigned long)(-sval); }
                else uval = (unsigned long)sval;
            } else {
                if (spec == 'p') {
                    uval = (unsigned long)(uintptr_t)va_arg(ap, void *);
                    base = 16;
                } else {
                    uval = va_arg(ap, unsigned long);
                    if (spec == 'x') base = 16;
                    else if (spec == 'X') { base = 16; digits = "0123456789ABCDEF"; }
                    else if (spec == 'o') base = 8;
                }
            }

            char nbuf[32];
            int nlen = 0;
            if (uval == 0 && prec == 0) {
                nlen = 0;
            } else {
                do {
                    nbuf[nlen++] = digits[uval % (unsigned long)base];
                    uval /= (unsigned long)base;
                } while (uval > 0 && nlen < (int)sizeof(nbuf));
            }
            while (nlen < prec && nlen < (int)sizeof(nbuf)) {
                nbuf[nlen++] = '0';
            }

            char sign_ch = 0;
            if (neg) sign_ch = '-';
            else if (plus_sign) sign_ch = '+';
            else if (space_sign) sign_ch = ' ';

            int total_len = nlen + (sign_ch ? 1 : 0);
            int pad = width - total_len;
            char pad_ch = (zero_pad && !left_align && prec < 0) ? '0' : ' ';

            if (!left_align && pad_ch == ' ') {
                while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            }
            if (sign_ch) fmt_putc(str, size, &idx, sign_ch);
            if (!left_align && pad_ch == '0') {
                while (pad-- > 0) fmt_putc(str, size, &idx, '0');
            }
            while (nlen-- > 0) fmt_putc(str, size, &idx, nbuf[nlen]);
            if (left_align) {
                while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            }
        } else if (spec == 'f' || spec == 'F' || spec == 'g' || spec == 'G' || spec == 'e' || spec == 'E') {
            double fval = va_arg(ap, double);
            if (isnan(fval)) {
                const char *s = "nan";
                while (*s) fmt_putc(str, size, &idx, *s++);
                continue;
            }
            int neg = 0;
            if (fval < 0.0) { neg = 1; fval = -fval; }
            int fprec = (prec < 0) ? 6 : prec;
            if (fprec > 9) fprec = 9;

            double scale = 1.0;
            for (int i = 0; i < fprec; i++) scale *= 10.0;
            unsigned long long scaled = (unsigned long long)(fval * scale + 0.5);
            unsigned long long ipart = (unsigned long long)(scaled / (unsigned long long)scale);
            unsigned long long fpart = (unsigned long long)(scaled % (unsigned long long)scale);

            char ibuf[32];
            int ilen = 0;
            do {
                ibuf[ilen++] = (char)('0' + (ipart % 10));
                ipart /= 10;
            } while (ipart > 0 && ilen < (int)sizeof(ibuf));

            char fbuf[16];
            for (int i = fprec - 1; i >= 0; i--) {
                fbuf[i] = (char)('0' + (fpart % 10));
                fpart /= 10;
            }

            if ((spec == 'g' || spec == 'G') && fprec > 0) {
                while (fprec > 0 && fbuf[fprec - 1] == '0') fprec--;
            }

            int total_len = ilen + (neg ? 1 : 0) + (fprec > 0 ? (1 + fprec) : 0);
            int pad = width - total_len;
            if (!left_align) {
                char pad_ch = zero_pad ? '0' : ' ';
                if (neg && pad_ch == '0') { fmt_putc(str, size, &idx, '-'); neg = 0; }
                while (pad-- > 0) fmt_putc(str, size, &idx, pad_ch);
            }
            if (neg) fmt_putc(str, size, &idx, '-');
            while (ilen-- > 0) fmt_putc(str, size, &idx, ibuf[ilen]);
            if (fprec > 0) {
                fmt_putc(str, size, &idx, '.');
                for (int i = 0; i < fprec; i++) fmt_putc(str, size, &idx, fbuf[i]);
            }
            if (left_align) {
                while (pad-- > 0) fmt_putc(str, size, &idx, ' ');
            }
        }
    }

    if (str && size > 0) {
        if (idx < size) str[idx] = '\0';
        else str[size - 1] = '\0';
    }
    return (int)idx;
}

int snprintf(char *str, size_t size, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int r = vsnprintf(str, size, format, ap);
    va_end(ap);
    return r;
}

int vsprintf(char *str, const char *format, va_list ap) {
    return vsnprintf(str, 0x7fffffff, format, ap);
}

int sprintf(char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int r = vsnprintf(str, 0x7fffffff, format, ap);
    va_end(ap);
    return r;
}

/* =========================================================================
 * sscanf / fscanf
 * ========================================================================= */
int vsscanf(const char *str, const char *format, va_list ap) {
    int count = 0;
    const char *s = str;
    const char *f = format;

    while (*f && *s) {
        if (isspace((unsigned char)*f)) {
            while (isspace((unsigned char)*f)) f++;
            while (isspace((unsigned char)*s)) s++;
            continue;
        }
        if (*f != '%') {
            if (*s != *f) break;
            s++;
            f++;
            continue;
        }
        f++; /* skip '%' */
        if (*f == '%') {
            if (*s != '%') break;
            s++;
            f++;
            continue;
        }

        int suppress = 0;
        if (*f == '*') { suppress = 1; f++; }

        int width = 0;
        while (isdigit((unsigned char)*f)) {
            width = width * 10 + (*f - '0');
            f++;
        }

        int long_conversion = 0;
        while (*f == 'l' || *f == 'h') {
            if (*f == 'l') long_conversion = 1;
            f++;
        }

        char spec = *f ? *f++ : '\0';
        if (!spec) break;

        if (spec != 'c' && spec != '[') {
            while (isspace((unsigned char)*s)) s++;
            if (!*s) break;
        }

        if (spec == 'd' || spec == 'i' || spec == 'u' || spec == 'x' || spec == 'X') {
            int base = (spec == 'x' || spec == 'X') ? 16 : (spec == 'i' ? 0 : 10);
            char *end = NULL;
            long val = strtol(s, &end, base);
            if (end == s) break;
            if (!suppress) {
                int *out = va_arg(ap, int *);
                *out = (int)val;
                count++;
            }
            s = end;
        } else if (spec == 'f' || spec == 'g' || spec == 'e') {
            char *end = NULL;
            double val = strtod(s, &end);
            if (end == s) break;
            if (!suppress) {
                if (long_conversion) *va_arg(ap, double *) = val;
                else *va_arg(ap, float *) = (float)val;
                count++;
            }
            s = end;
        } else if (spec == 's') {
            char *out = suppress ? NULL : va_arg(ap, char *);
            int maxw = width > 0 ? width : 0x7fffffff;
            int n = 0;
            while (*s && !isspace((unsigned char)*s) && n < maxw) {
                if (out) out[n] = *s;
                s++;
                n++;
            }
            if (n == 0) break;
            if (out) {
                out[n] = '\0';
                count++;
            }
        } else if (spec == 'c') {
            if (!*s) break;
            if (!suppress) {
                char *out = va_arg(ap, char *);
                *out = *s;
                count++;
            }
            s++;
        }
    }
    return count;
}

int sscanf(const char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int r = vsscanf(str, format, ap);
    va_end(ap);
    return r;
}

/* =========================================================================
 * stdio.h FILE* backed by JS VFS
 * ========================================================================= */
struct _WASM_FILE {
    int fd;
    int eof;
    int err;
    int unget_char;
};

static struct _WASM_FILE g_stdin_file  = { -1, 0, 0, -1 };
static struct _WASM_FILE g_stdout_file = { -2, 0, 0, -1 };
static struct _WASM_FILE g_stderr_file = { -3, 0, 0, -1 };

FILE *stdin  = &g_stdin_file;
FILE *stdout = &g_stdout_file;
FILE *stderr = &g_stderr_file;

FILE *fopen(const char *pathname, const char *mode) {
    if (!pathname || !mode) return NULL;
    int fd = js_vfs_open(pathname, mode);
    if (fd <= 0) return NULL;
    FILE *f = (FILE *)malloc(sizeof(FILE));
    if (!f) {
        js_vfs_close(fd);
        return NULL;
    }
    f->fd = fd;
    f->eof = 0;
    f->err = 0;
    f->unget_char = -1;
    return f;
}

FILE *freopen(const char *pathname, const char *mode, FILE *stream) {
    if (stream && stream->fd > 0) {
        js_vfs_close(stream->fd);
    }
    int fd = js_vfs_open(pathname, mode);
    if (fd <= 0) return NULL;
    if (!stream) stream = (FILE *)malloc(sizeof(FILE));
    stream->fd = fd;
    stream->eof = 0;
    stream->err = 0;
    stream->unget_char = -1;
    return stream;
}

int fclose(FILE *stream) {
    if (!stream) return EOF;
    if (stream->fd >= 0) {
        js_vfs_close(stream->fd);
        free(stream);
    }
    return 0;
}

size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream) {
    if (!stream || stream->fd < 0 || size == 0 || nmemb == 0) return 0;
    size_t total = size * nmemb;
    unsigned char *dst = (unsigned char *)ptr;
    size_t read_bytes = 0;

    if (stream->unget_char != -1 && total > 0) {
        *dst++ = (unsigned char)stream->unget_char;
        stream->unget_char = -1;
        read_bytes = 1;
    }

    if (read_bytes < total) {
        int n = js_vfs_read(stream->fd, dst, (int)(total - read_bytes));
        if (n < 0) {
            stream->err = 1;
            return read_bytes / size;
        }
        if (n > 0) {
            read_bytes += (size_t)n;
        }
        if (read_bytes < total) {
            stream->eof = 1;
        }
    }
    return read_bytes / size;
}

size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream) {
    if (!stream || size == 0 || nmemb == 0) return 0;
    size_t total = size * nmemb;
    if (stream == stdout || stream == stderr || stream->fd < 0) {
        js_console_print((const char *)ptr, (int)total);
        return nmemb;
    }
    int n = js_vfs_write(stream->fd, ptr, (int)total);
    if (n < 0) {
        stream->err = 1;
        return 0;
    }
    return (size_t)n / size;
}

int fseek(FILE *stream, long offset, int whence) {
    if (!stream || stream->fd < 0) return -1;
    int result = js_vfs_seek(stream->fd, (int)offset, whence);
    if (result == 0) {
        stream->unget_char = -1;
        stream->eof = 0;
    }
    return result;
}

long ftell(FILE *stream) {
    if (!stream || stream->fd < 0) return -1;
    long pos = (long)js_vfs_tell(stream->fd);
    if (stream->unget_char != -1 && pos > 0) pos--;
    return pos;
}

void rewind(FILE *stream) {
    fseek(stream, 0, SEEK_SET);
}

int fflush(FILE *stream) {
    (void)stream;
    return 0;
}

int feof(FILE *stream) {
    if (!stream || stream->fd < 0) return 1;
    if (stream->unget_char != -1) return 0;
    return stream->eof;
}

int ferror(FILE *stream) {
    return stream ? stream->err : 1;
}

void clearerr(FILE *stream) {
    if (stream) {
        stream->eof = 0;
        stream->err = 0;
    }
}

int fgetc(FILE *stream) {
    unsigned char c;
    if (fread(&c, 1, 1, stream) == 1) return (int)c;
    return EOF;
}

int getc(FILE *stream) { return fgetc(stream); }

int ungetc(int c, FILE *stream) {
    if (!stream || c == EOF) return EOF;
    stream->unget_char = c & 0xff;
    stream->eof = 0;
    return stream->unget_char;
}

char *fgets(char *s, int size, FILE *stream) {
    if (!s || size <= 0 || !stream) return NULL;
    int i = 0;
    while (i < size - 1) {
        int c = fgetc(stream);
        if (c == EOF) {
            if (i == 0) return NULL;
            break;
        }
        s[i++] = (char)c;
        if (c == '\n') break;
    }
    s[i] = '\0';
    return s;
}

int fputc(int c, FILE *stream) {
    unsigned char ch = (unsigned char)c;
    return (fwrite(&ch, 1, 1, stream) == 1) ? (int)ch : EOF;
}

int putc(int c, FILE *stream) { return fputc(c, stream); }
int putchar(int c) { return fputc(c, stdout); }

int fputs(const char *s, FILE *stream) {
    size_t len = strlen(s);
    return (fwrite(s, 1, len, stream) == len) ? 0 : EOF;
}

int puts(const char *s) {
    fputs(s, stdout);
    fputc('\n', stdout);
    return 0;
}

int remove(const char *pathname) {
    return js_vfs_remove(pathname);
}

int rename(const char *oldpath, const char *newpath) {
    (void)oldpath;
    (void)newpath;
    return -1;
}

int setvbuf(FILE *stream, char *buf, int mode, size_t size) {
    (void)stream; (void)buf; (void)mode; (void)size;
    return 0;
}

void perror(const char *s) {
    if (s) js_console_print(s, (int)strlen(s));
}

int vfprintf(FILE *stream, const char *format, va_list ap) {
    char buf[2048];
    int n = vsnprintf(buf, sizeof(buf), format, ap);
    if (n > 0) {
        size_t len = (size_t)n < sizeof(buf) ? (size_t)n : sizeof(buf) - 1;
        fwrite(buf, 1, len, stream ? stream : stdout);
    }
    return n;
}

int vprintf(const char *format, va_list ap) {
    return vfprintf(stdout, format, ap);
}

int fprintf(FILE *stream, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int r = vfprintf(stream, format, ap);
    va_end(ap);
    return r;
}

int printf(const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int r = vfprintf(stdout, format, ap);
    va_end(ap);
    return r;
}

int fscanf(FILE *stream, const char *format, ...) {
    if (!stream) return EOF;
    char buf[1024];
    if (!fgets(buf, sizeof(buf), stream)) return EOF;
    va_list ap;
    va_start(ap, format);
    int r = vsscanf(buf, format, ap);
    va_end(ap);
    return r;
}
