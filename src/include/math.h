#ifndef _WASM_MATH_H
#define _WASM_MATH_H

#define M_PI 3.14159265358979323846
#define HUGE_VAL (__builtin_huge_val())

double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan(double x);
double atan2(double y, double x);

float sinf(float x);
float cosf(float x);
float tanf(float x);
float asinf(float x);
float acosf(float x);
float atanf(float x);
float atan2f(float y, float x);

double sqrt(double x);
float sqrtf(float x);
double fabs(double x);
float fabsf(float x);
double floor(double x);
float floorf(float x);
double ceil(double x);
float ceilf(float x);
double rint(double x);
float rintf(float x);

double pow(double x, double y);
float powf(float x, float y);
double fmod(double x, double y);
float fmodf(float x, float y);
double exp(double x);
double log(double x);
double log10(double x);
double ldexp(double x, int exp);
double frexp(double x, int *exp);
double modf(double x, double *iptr);

#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)

#endif
