#ifndef _WASM_TIME_H
#define _WASM_TIME_H

#include <stddef.h>
#include <sys/types.h>

typedef long clock_t;
#define CLOCKS_PER_SEC 1000

struct tm {
    int tm_sec;
    int tm_min;
    int tm_hour;
    int tm_mday;
    int tm_mon;
    int tm_year;
    int tm_wday;
    int tm_yday;
    int tm_isdst;
};

time_t time(time_t *tloc);
struct tm *localtime(const time_t *timer);
struct tm *gmtime(const time_t *timer);
char *ctime(const time_t *timer);
char *asctime(const struct tm *timeptr);
size_t strftime(char *s, size_t maxsize, const char *format, const struct tm *timeptr);
clock_t clock(void);
double difftime(time_t time1, time_t time0);
time_t mktime(struct tm *timeptr);

#endif
