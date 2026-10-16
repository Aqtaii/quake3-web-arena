#include "../../Quake-III-Arena/code/renderer/tr_local.h"
#include <stdint.h>
#include <string.h>

#define WASM_IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
#define WASM_EXPORT(name) __attribute__((export_name(#name), visibility("default")))

/* 3D World MVP Snapshot for 3D In-Game Lava & Effects */
static float g_world_mvp[16];
static int g_has_world_mvp = 0;

WASM_EXPORT(wasm_q3_world_mvp)
const float *wasm_q3_world_mvp(void) {
    return g_has_world_mvp ? g_world_mvp : NULL;
}

/* WebGL2 Host Bridge Imports */
WASM_IMPORT("env", "js_gl_init") extern void js_gl_init(int *width, int *height);
WASM_IMPORT("env", "js_gl_viewport") extern void js_gl_viewport(int x, int y, int w, int h);
WASM_IMPORT("env", "js_gl_scissor") extern void js_gl_scissor(int enabled, int x, int y, int w, int h);
WASM_IMPORT("env", "js_gl_clear") extern void js_gl_clear(unsigned int mask, float r, float g, float b, float a, float depth, int stencil);
WASM_IMPORT("env", "js_gl_state") extern void js_gl_state(
    int blend_enabled, unsigned int src_factor, unsigned int dst_factor,
    int depth_test, unsigned int depth_func, int depth_mask,
    int cull_enabled, unsigned int cull_face,
    int poly_offset_enabled, float poly_factor, float poly_units,
    int color_mask_r, int color_mask_g, int color_mask_b, int color_mask_a,
    float depth_near, float depth_far
);
WASM_IMPORT("env", "js_gl_tex_image_2d") extern void js_gl_tex_image_2d(int tex_id, int level, int internal_format, int width, int height, const void *pixels);
WASM_IMPORT("env", "js_gl_tex_sub_image_2d") extern void js_gl_tex_sub_image_2d(int tex_id, int level, int xoff, int yoff, int width, int height, const void *pixels);
WASM_IMPORT("env", "js_gl_tex_parameter") extern void js_gl_tex_parameter(int tex_id, unsigned int pname, int param);
WASM_IMPORT("env", "js_gl_delete_texture") extern void js_gl_delete_texture(int tex_id);
WASM_IMPORT("env", "js_gl_draw") extern void js_gl_draw(
    unsigned int mode,
    const void *verts, int num_verts,
    const void *indices, int num_indices,
    const float *mvp,
    const float *modelview,
    int tex0_id, int tex1_id,
    int tex0_enabled, int tex1_enabled,
    int tex0_env, int tex1_env,
    int alpha_test_enabled, unsigned int alpha_func, float alpha_ref,
    int clip_plane_enabled, const float *clip_plane
);
WASM_IMPORT("env", "js_gl_end_frame") extern void js_gl_end_frame(void);
WASM_IMPORT("env", "js_gl_get_error") extern int js_gl_get_error(void);
WASM_IMPORT("env", "js_gl_stencil_func") extern void js_gl_stencil_func(unsigned int func, int ref, unsigned int mask);
WASM_IMPORT("env", "js_gl_stencil_mask") extern void js_gl_stencil_mask(unsigned int mask);
WASM_IMPORT("env", "js_gl_stencil_op") extern void js_gl_stencil_op(unsigned int fail, unsigned int zfail, unsigned int zpass);
WASM_IMPORT("env", "js_gl_stencil_test") extern void js_gl_stencil_test(int enabled);
WASM_IMPORT("env", "js_gl_read_pixels") extern void js_gl_read_pixels(int x, int y, int width, int height, unsigned int format, unsigned int type, void *pixels);
WASM_IMPORT("env", "js_gl_render_3d_lava") extern void js_gl_render_3d_lava(const float *mvp);

/* Interleaved 32-byte vertex sent to WebGL2 */
typedef struct {
    float x, y, z;
    float u0, v0;
    float u1, v1;
    uint8_t r, g, b, a;
} WasmVertex;

#define MAX_WASM_VERTS 8192
#define MAX_WASM_INDICES 32768

static WasmVertex g_vbuf[MAX_WASM_VERTS];
static uint16_t g_ibuf[MAX_WASM_INDICES];

/* OpenGL State Machine in C */
static GLenum g_matrix_mode = GL_MODELVIEW;
static float g_mv_stack[16][16];
static int g_mv_top = 0;
static float g_proj_stack[8][16];
static int g_proj_top = 0;
static float g_tex_stack[4][16];
static int g_tex_top = 0;
static float g_mvp[16];
static int g_mvp_dirty = 1;

static int g_active_tmu = 0;
static int g_client_tmu = 0;

typedef struct {
    int tex_2d_enabled;
    int bound_tex;
    int tex_env;
    int texcoord_array_enabled;
    int texcoord_size;
    GLenum texcoord_type;
    int texcoord_stride;
    const void *texcoord_ptr;
    float cur_st[2];
} TMUState;

static TMUState g_tmu[2];

static int g_vertex_array_enabled = 0;
static int g_vertex_size = 3;
static GLenum g_vertex_type = GL_FLOAT;
static int g_vertex_stride = 0;
static const void *g_vertex_ptr = NULL;

static int g_color_array_enabled = 0;
static int g_color_size = 4;
static GLenum g_color_type = GL_UNSIGNED_BYTE;
static int g_color_stride = 0;
static const void *g_color_ptr = NULL;

static uint8_t g_cur_color[4] = { 255, 255, 255, 255 };
static int g_locked_first = 0;
static int g_locked_count = 0;

/* Render Pipeline State */
static int g_blend_enabled = 0;
static GLenum g_blend_src = GL_ONE;
static GLenum g_blend_dst = GL_ZERO;
static int g_depth_test = 0;
static GLenum g_depth_func = GL_LEQUAL;
static int g_depth_mask = 1;
static float g_depth_near = 0.0f;
static float g_depth_far = 1.0f;
static int g_cull_enabled = 0;
static GLenum g_cull_face = GL_BACK;
static int g_poly_offset_enabled = 0;
static float g_poly_factor = 0.0f;
static float g_poly_units = 0.0f;
static int g_color_mask[4] = { 1, 1, 1, 1 };
static GLenum g_polygon_mode = GL_FILL;
static int g_state_dirty = 1;

static int g_alpha_test_enabled = 0;
static GLenum g_alpha_func = GL_ALWAYS;
static float g_alpha_ref = 0.0f;

static int g_clip_plane_enabled = 0;
static float g_clip_plane[4] = { 0.0f, 0.0f, 0.0f, 0.0f };

static int g_scissor_enabled = 0;
static int g_scissor_box[4] = { 0, 0, 640, 480 };
static int g_viewport_box[4] = { 0, 0, 640, 480 };

static float g_clear_color[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
static float g_clear_depth = 1.0f;
static int g_clear_stencil = 0;

/* Immediate mode state */
static int g_in_begin = 0;
static GLenum g_begin_mode = GL_TRIANGLES;
static int g_imm_count = 0;

static void mat4_identity(float *m) {
    memset(m, 0, 16 * sizeof(float));
    m[0] = m[5] = m[10] = m[15] = 1.0f;
}

static void mat4_mul(float *out, const float *a, const float *b) {
    float r[16];
    for (int col = 0; col < 4; col++) {
        for (int row = 0; row < 4; row++) {
            r[col * 4 + row] =
                a[0 * 4 + row] * b[col * 4 + 0] +
                a[1 * 4 + row] * b[col * 4 + 1] +
                a[2 * 4 + row] * b[col * 4 + 2] +
                a[3 * 4 + row] * b[col * 4 + 3];
        }
    }
    memcpy(out, r, 16 * sizeof(float));
}

void Wasm_Render3DLava(const float *proj, const float *modelview) {
    if (!proj || !modelview) return;
    mat4_mul(g_world_mvp, proj, modelview);
    g_has_world_mvp = 1;
    js_gl_render_3d_lava(g_world_mvp);
}

static float *current_matrix(void) {
    if (g_matrix_mode == GL_PROJECTION) return g_proj_stack[g_proj_top];
    if (g_matrix_mode == GL_TEXTURE) return g_tex_stack[g_tex_top];
    return g_mv_stack[g_mv_top];
}

static void sync_gl_state(void) {
    if (g_state_dirty) {
        js_gl_state(
            g_blend_enabled, g_blend_src, g_blend_dst,
            g_depth_test, g_depth_func, g_depth_mask,
            g_cull_enabled, g_cull_face,
            g_poly_offset_enabled, g_poly_factor, g_poly_units,
            g_color_mask[0], g_color_mask[1], g_color_mask[2], g_color_mask[3],
            g_depth_near, g_depth_far
        );
        g_state_dirty = 0;
    }
    if (g_mvp_dirty) {
        mat4_mul(g_mvp, g_proj_stack[g_proj_top], g_mv_stack[g_mv_top]);
        g_mvp_dirty = 0;
    }
}

/* =========================================================================
 * QGL Implementation Functions
 * ========================================================================= */
static void APIENTRY impl_glActiveTextureARB(GLenum texture) {
    int idx = (int)(texture - GL_TEXTURE0_ARB);
    if (idx >= 0 && idx < 2) g_active_tmu = idx;
}

static void APIENTRY impl_glClientActiveTextureARB(GLenum texture) {
    int idx = (int)(texture - GL_TEXTURE0_ARB);
    if (idx >= 0 && idx < 2) g_client_tmu = idx;
}

static void APIENTRY impl_glMultiTexCoord2fARB(GLenum target, GLfloat s, GLfloat t) {
    int idx = (target >= GL_TEXTURE0_ARB) ? (int)(target - GL_TEXTURE0_ARB) : target;
    if (idx >= 0 && idx < 2) {
        g_tmu[idx].cur_st[0] = s;
        g_tmu[idx].cur_st[1] = t;
    }
}

static void APIENTRY impl_glLockArraysEXT(GLint first, GLint count) {
    g_locked_first = first;
    g_locked_count = count;
}

static void APIENTRY impl_glUnlockArraysEXT(void) {
    g_locked_first = 0;
    g_locked_count = 0;
}

static void APIENTRY impl_glAlphaFunc(GLenum func, GLclampf ref) {
    g_alpha_func = func;
    g_alpha_ref = ref;
}

static void APIENTRY impl_glBindTexture(GLenum target, GLuint texture) {
    (void)target;
    g_tmu[g_active_tmu].bound_tex = (int)texture;
}

static void APIENTRY impl_glBlendFunc(GLenum sfactor, GLenum dfactor) {
    if (g_blend_src != sfactor || g_blend_dst != dfactor) {
        g_blend_src = sfactor;
        g_blend_dst = dfactor;
        g_state_dirty = 1;
    }
}

static void APIENTRY impl_glClear(GLbitfield mask) {
    sync_gl_state();
    js_gl_clear(mask, g_clear_color[0], g_clear_color[1], g_clear_color[2], g_clear_color[3], g_clear_depth, g_clear_stencil);
}

static void APIENTRY impl_glClearColor(GLclampf red, GLclampf green, GLclampf blue, GLclampf alpha) {
    g_clear_color[0] = red;
    g_clear_color[1] = green;
    g_clear_color[2] = blue;
    g_clear_color[3] = alpha;
}

static void APIENTRY impl_glClearDepth(GLclampd depth) {
    g_clear_depth = (float)depth;
}

static void APIENTRY impl_glClearStencil(GLint s) {
    g_clear_stencil = s;
}

static void APIENTRY impl_glClipPlane(GLenum plane, const GLdouble *equation) {
    (void)plane;
    if (equation) {
        /* OpenGL stores the plane in eye space at definition time. The
           renderer sets s_flipMatrix before defining portal/mirror planes. */
        float inverse[4][8];
        int row, col, pivot, k;
        for (row = 0; row < 4; row++) {
            for (col = 0; col < 4; col++) {
                inverse[row][col] = g_mv_stack[g_mv_top][col * 4 + row];
                inverse[row][col + 4] = row == col ? 1.0f : 0.0f;
            }
        }
        for (col = 0; col < 4; col++) {
            float divisor;
            pivot = col;
            for (row = col + 1; row < 4; row++)
                if (fabsf(inverse[row][col]) > fabsf(inverse[pivot][col])) pivot = row;
            if (fabsf(inverse[pivot][col]) < 1e-12f) return;
            if (pivot != col) for (k = 0; k < 8; k++) {
                float temporary = inverse[col][k];
                inverse[col][k] = inverse[pivot][k];
                inverse[pivot][k] = temporary;
            }
            divisor = inverse[col][col];
            for (k = 0; k < 8; k++) inverse[col][k] /= divisor;
            for (row = 0; row < 4; row++) if (row != col) {
                float factor = inverse[row][col];
                for (k = 0; k < 8; k++) inverse[row][k] -= factor * inverse[col][k];
            }
        }
        for (row = 0; row < 4; row++) {
            g_clip_plane[row] = 0.0f;
            for (col = 0; col < 4; col++)
                g_clip_plane[row] += inverse[col][row + 4] * (float)equation[col];
        }
    }
}

static uint8_t clamp_u8(float f) {
    int v = (int)(f * 255.0f + 0.5f);
    if (v < 0) return 0;
    if (v > 255) return 255;
    return (uint8_t)v;
}

static void APIENTRY impl_glColor3f(GLfloat red, GLfloat green, GLfloat blue) {
    g_cur_color[0] = clamp_u8(red);
    g_cur_color[1] = clamp_u8(green);
    g_cur_color[2] = clamp_u8(blue);
    g_cur_color[3] = 255;
}

static void APIENTRY impl_glColor4f(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha) {
    g_cur_color[0] = clamp_u8(red);
    g_cur_color[1] = clamp_u8(green);
    g_cur_color[2] = clamp_u8(blue);
    g_cur_color[3] = clamp_u8(alpha);
}

static void APIENTRY impl_glColor4ubv(const GLubyte *v) {
    if (v) {
        g_cur_color[0] = v[0];
        g_cur_color[1] = v[1];
        g_cur_color[2] = v[2];
        g_cur_color[3] = v[3];
    }
}

static void APIENTRY impl_glColorMask(GLboolean red, GLboolean green, GLboolean blue, GLboolean alpha) {
    g_color_mask[0] = red ? 1 : 0;
    g_color_mask[1] = green ? 1 : 0;
    g_color_mask[2] = blue ? 1 : 0;
    g_color_mask[3] = alpha ? 1 : 0;
    g_state_dirty = 1;
}

static void APIENTRY impl_glColorPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer) {
    g_color_size = size;
    g_color_type = type;
    g_color_stride = stride;
    g_color_ptr = pointer;
}

static void APIENTRY impl_glCullFace(GLenum mode) {
    if (g_cull_face != mode) {
        g_cull_face = mode;
        g_state_dirty = 1;
    }
}

static void APIENTRY impl_glDeleteTextures(GLsizei n, const GLuint *textures) {
    if (!textures) return;
    for (GLsizei i = 0; i < n; i++) {
        js_gl_delete_texture((int)textures[i]);
    }
}

static void APIENTRY impl_glDepthFunc(GLenum func) {
    if (g_depth_func != func) {
        g_depth_func = func;
        g_state_dirty = 1;
    }
}

static void APIENTRY impl_glDepthMask(GLboolean flag) {
    int m = flag ? 1 : 0;
    if (g_depth_mask != m) {
        g_depth_mask = m;
        g_state_dirty = 1;
    }
}

static void APIENTRY impl_glDepthRange(GLclampd zNear, GLclampd zFar) {
    g_depth_near = (float)zNear;
    g_depth_far = (float)zFar;
    g_state_dirty = 1;
}

static void APIENTRY impl_glEnable(GLenum cap) {
    switch (cap) {
        case GL_TEXTURE_2D:
            g_tmu[g_active_tmu].tex_2d_enabled = 1;
            break;
        case GL_BLEND:
            if (!g_blend_enabled) { g_blend_enabled = 1; g_state_dirty = 1; }
            break;
        case GL_DEPTH_TEST:
            if (!g_depth_test) { g_depth_test = 1; g_state_dirty = 1; }
            break;
        case GL_CULL_FACE:
            if (!g_cull_enabled) { g_cull_enabled = 1; g_state_dirty = 1; }
            break;
        case GL_POLYGON_OFFSET_FILL:
            if (!g_poly_offset_enabled) { g_poly_offset_enabled = 1; g_state_dirty = 1; }
            break;
        case GL_ALPHA_TEST:
            g_alpha_test_enabled = 1;
            break;
        case GL_CLIP_PLANE0:
            g_clip_plane_enabled = 1;
            break;
        case GL_SCISSOR_TEST:
            if (!g_scissor_enabled) {
                g_scissor_enabled = 1;
                js_gl_scissor(1, g_scissor_box[0], g_scissor_box[1], g_scissor_box[2], g_scissor_box[3]);
            }
            break;
        case GL_STENCIL_TEST:
            js_gl_stencil_test(1);
            break;
        default:
            break;
    }
}

static void APIENTRY impl_glDisable(GLenum cap) {
    switch (cap) {
        case GL_TEXTURE_2D:
            g_tmu[g_active_tmu].tex_2d_enabled = 0;
            break;
        case GL_BLEND:
            if (g_blend_enabled) { g_blend_enabled = 0; g_state_dirty = 1; }
            break;
        case GL_DEPTH_TEST:
            if (g_depth_test) { g_depth_test = 0; g_state_dirty = 1; }
            break;
        case GL_CULL_FACE:
            if (g_cull_enabled) { g_cull_enabled = 0; g_state_dirty = 1; }
            break;
        case GL_POLYGON_OFFSET_FILL:
            if (g_poly_offset_enabled) { g_poly_offset_enabled = 0; g_state_dirty = 1; }
            break;
        case GL_ALPHA_TEST:
            g_alpha_test_enabled = 0;
            break;
        case GL_CLIP_PLANE0:
            g_clip_plane_enabled = 0;
            break;
        case GL_SCISSOR_TEST:
            if (g_scissor_enabled) {
                g_scissor_enabled = 0;
                js_gl_scissor(0, g_scissor_box[0], g_scissor_box[1], g_scissor_box[2], g_scissor_box[3]);
            }
            break;
        case GL_STENCIL_TEST:
            js_gl_stencil_test(0);
            break;
        default:
            break;
    }
}

static void APIENTRY impl_glEnableClientState(GLenum array) {
    if (array == GL_VERTEX_ARRAY) g_vertex_array_enabled = 1;
    else if (array == GL_COLOR_ARRAY) g_color_array_enabled = 1;
    else if (array == GL_TEXTURE_COORD_ARRAY) g_tmu[g_client_tmu].texcoord_array_enabled = 1;
}

static void APIENTRY impl_glDisableClientState(GLenum array) {
    if (array == GL_VERTEX_ARRAY) g_vertex_array_enabled = 0;
    else if (array == GL_COLOR_ARRAY) g_color_array_enabled = 0;
    else if (array == GL_TEXTURE_COORD_ARRAY) g_tmu[g_client_tmu].texcoord_array_enabled = 0;
}

static void APIENTRY impl_glVertexPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer) {
    g_vertex_size = size;
    g_vertex_type = type;
    g_vertex_stride = stride;
    g_vertex_ptr = pointer;
}

static void APIENTRY impl_glTexCoordPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer) {
    g_tmu[g_client_tmu].texcoord_size = size;
    g_tmu[g_client_tmu].texcoord_type = type;
    g_tmu[g_client_tmu].texcoord_stride = stride;
    g_tmu[g_client_tmu].texcoord_ptr = pointer;
}

static void populate_vertex_from_arrays(WasmVertex *dst, int idx) {
    if (g_vertex_array_enabled && g_vertex_ptr) {
        int vstride = g_vertex_stride ? g_vertex_stride : (g_vertex_size * 4);
        const float *vp = (const float *)((const uint8_t *)g_vertex_ptr + idx * vstride);
        dst->x = vp[0];
        dst->y = vp[1];
        dst->z = (g_vertex_size >= 3) ? vp[2] : 0.0f;
    } else {
        dst->x = dst->y = dst->z = 0.0f;
    }

    if (g_color_array_enabled && g_color_ptr) {
        int cstride = g_color_stride ? g_color_stride : 4;
        const uint8_t *cp = (const uint8_t *)g_color_ptr + idx * cstride;
        dst->r = cp[0];
        dst->g = cp[1];
        dst->b = cp[2];
        dst->a = (g_color_size >= 4) ? cp[3] : 255;
    } else {
        dst->r = g_cur_color[0];
        dst->g = g_cur_color[1];
        dst->b = g_cur_color[2];
        dst->a = g_cur_color[3];
    }

    if (g_tmu[0].texcoord_array_enabled && g_tmu[0].texcoord_ptr) {
        int tstride0 = g_tmu[0].texcoord_stride ? g_tmu[0].texcoord_stride : (g_tmu[0].texcoord_size * 4);
        const float *tp0 = (const float *)((const uint8_t *)g_tmu[0].texcoord_ptr + idx * tstride0);
        dst->u0 = tp0[0];
        dst->v0 = tp0[1];
    } else {
        dst->u0 = g_tmu[0].cur_st[0];
        dst->v0 = g_tmu[0].cur_st[1];
    }

    if (g_tmu[1].texcoord_array_enabled && g_tmu[1].texcoord_ptr) {
        int tstride1 = g_tmu[1].texcoord_stride ? g_tmu[1].texcoord_stride : (g_tmu[1].texcoord_size * 4);
        const float *tp1 = (const float *)((const uint8_t *)g_tmu[1].texcoord_ptr + idx * tstride1);
        dst->u1 = tp1[0];
        dst->v1 = tp1[1];
    } else {
        dst->u1 = g_tmu[1].cur_st[0];
        dst->v1 = g_tmu[1].cur_st[1];
    }
}

static void APIENTRY impl_glDrawElements(GLenum mode, GLsizei count, GLenum type, const GLvoid *indices) {
    if (count <= 0 || !indices) return;
    if (count > MAX_WASM_INDICES) count = MAX_WASM_INDICES;

    int max_idx = 0;
    if (type == GL_UNSIGNED_INT || type == GL_INT) {
        const uint32_t *src = (const uint32_t *)indices;
        for (int i = 0; i < count; i++) {
            uint32_t v = src[i];
            if ((int)v >= MAX_WASM_VERTS) v = MAX_WASM_VERTS - 1;
            g_ibuf[i] = (uint16_t)v;
            if ((int)v > max_idx) max_idx = (int)v;
        }
    } else if (type == GL_UNSIGNED_SHORT || type == GL_SHORT) {
        const uint16_t *src = (const uint16_t *)indices;
        for (int i = 0; i < count; i++) {
            uint16_t v = src[i];
            if ((int)v >= MAX_WASM_VERTS) v = MAX_WASM_VERTS - 1;
            g_ibuf[i] = v;
            if ((int)v > max_idx) max_idx = (int)v;
        }
    } else {
        return;
    }

    int num_verts = max_idx + 1;
    if (g_locked_count > num_verts && g_locked_count <= MAX_WASM_VERTS) {
        num_verts = g_locked_count;
    }
    for (int i = 0; i < num_verts; i++) {
        populate_vertex_from_arrays(&g_vbuf[i], i);
    }

    sync_gl_state();

    if (g_polygon_mode == GL_LINE && mode == GL_TRIANGLES) {
        /* Convert triangles to lines for r_showtris */
        static uint16_t line_ibuf[MAX_WASM_INDICES];
        int lcount = 0;
        for (int i = 0; i + 2 < count && lcount + 6 <= MAX_WASM_INDICES; i += 3) {
            uint16_t a = g_ibuf[i], b = g_ibuf[i + 1], c = g_ibuf[i + 2];
            line_ibuf[lcount++] = a; line_ibuf[lcount++] = b;
            line_ibuf[lcount++] = b; line_ibuf[lcount++] = c;
            line_ibuf[lcount++] = c; line_ibuf[lcount++] = a;
        }
        js_gl_draw(
            GL_LINES,
            g_vbuf, num_verts,
            line_ibuf, lcount,
            g_mvp, g_mv_stack[g_mv_top],
            g_tmu[0].bound_tex, g_tmu[1].bound_tex,
            g_tmu[0].tex_2d_enabled, g_tmu[1].tex_2d_enabled,
            g_tmu[0].tex_env, g_tmu[1].tex_env,
            g_alpha_test_enabled, g_alpha_func, g_alpha_ref,
            g_clip_plane_enabled, g_clip_plane
        );
        return;
    }

    if (g_mv_top == 0 && g_depth_test && (g_proj_stack[g_proj_top][11] != 0.0f)) {
        memcpy(g_world_mvp, g_mvp, sizeof(g_world_mvp));
        g_has_world_mvp = 1;
    }

    js_gl_draw(
        mode,
        g_vbuf, num_verts,
        g_ibuf, count,
        g_mvp, g_mv_stack[g_mv_top],
        g_tmu[0].bound_tex, g_tmu[1].bound_tex,
        g_tmu[0].tex_2d_enabled, g_tmu[1].tex_2d_enabled,
        g_tmu[0].tex_env, g_tmu[1].tex_env,
        g_alpha_test_enabled, g_alpha_func, g_alpha_ref,
        g_clip_plane_enabled, g_clip_plane
    );
}

static void APIENTRY impl_glBegin(GLenum mode) {
    g_in_begin = 1;
    g_begin_mode = mode;
    g_imm_count = 0;
}

static void emit_imm_vertex(float x, float y, float z) {
    if (!g_in_begin || g_imm_count >= MAX_WASM_VERTS) return;
    WasmVertex *v = &g_vbuf[g_imm_count++];
    v->x = x;
    v->y = y;
    v->z = z;
    v->u0 = g_tmu[0].cur_st[0];
    v->v0 = g_tmu[0].cur_st[1];
    v->u1 = g_tmu[1].cur_st[0];
    v->v1 = g_tmu[1].cur_st[1];
    v->r = g_cur_color[0];
    v->g = g_cur_color[1];
    v->b = g_cur_color[2];
    v->a = g_cur_color[3];
}

static void APIENTRY impl_glVertex2f(GLfloat x, GLfloat y) {
    emit_imm_vertex(x, y, 0.0f);
}

static void APIENTRY impl_glVertex3f(GLfloat x, GLfloat y, GLfloat z) {
    emit_imm_vertex(x, y, z);
}

static void APIENTRY impl_glVertex3fv(const GLfloat *v) {
    if (v) emit_imm_vertex(v[0], v[1], v[2]);
}

static void APIENTRY impl_glTexCoord2f(GLfloat s, GLfloat t) {
    g_tmu[0].cur_st[0] = s;
    g_tmu[0].cur_st[1] = t;
}

static void APIENTRY impl_glTexCoord2fv(const GLfloat *v) {
    if (v) {
        g_tmu[0].cur_st[0] = v[0];
        g_tmu[0].cur_st[1] = v[1];
    }
}

static void APIENTRY impl_glArrayElement(GLint i) {
    if (!g_in_begin || g_imm_count >= MAX_WASM_VERTS) return;
    populate_vertex_from_arrays(&g_vbuf[g_imm_count++], i);
}

static void APIENTRY impl_glEnd(void) {
    if (!g_in_begin) return;
    g_in_begin = 0;
    if (g_imm_count <= 0) return;

    int icount = 0;
    GLenum draw_mode = GL_TRIANGLES;

    if (g_begin_mode == GL_QUADS) {
        for (int i = 0; i + 3 < g_imm_count && icount + 6 <= MAX_WASM_INDICES; i += 4) {
            g_ibuf[icount++] = (uint16_t)(i + 0);
            g_ibuf[icount++] = (uint16_t)(i + 1);
            g_ibuf[icount++] = (uint16_t)(i + 2);
            g_ibuf[icount++] = (uint16_t)(i + 0);
            g_ibuf[icount++] = (uint16_t)(i + 2);
            g_ibuf[icount++] = (uint16_t)(i + 3);
        }
        draw_mode = GL_TRIANGLES;
    } else if (g_begin_mode == GL_TRIANGLE_STRIP) {
        for (int i = 0; i + 2 < g_imm_count && icount + 3 <= MAX_WASM_INDICES; i++) {
            if ((i & 1) == 0) {
                g_ibuf[icount++] = (uint16_t)(i + 0);
                g_ibuf[icount++] = (uint16_t)(i + 1);
                g_ibuf[icount++] = (uint16_t)(i + 2);
            } else {
                g_ibuf[icount++] = (uint16_t)(i + 1);
                g_ibuf[icount++] = (uint16_t)(i + 0);
                g_ibuf[icount++] = (uint16_t)(i + 2);
            }
        }
        draw_mode = GL_TRIANGLES;
    } else if (g_begin_mode == GL_TRIANGLE_FAN || g_begin_mode == GL_POLYGON) {
        for (int i = 1; i + 1 < g_imm_count && icount + 3 <= MAX_WASM_INDICES; i++) {
            g_ibuf[icount++] = 0;
            g_ibuf[icount++] = (uint16_t)i;
            g_ibuf[icount++] = (uint16_t)(i + 1);
        }
        draw_mode = GL_TRIANGLES;
    } else {
        draw_mode = g_begin_mode;
        for (int i = 0; i < g_imm_count && icount < MAX_WASM_INDICES; i++) {
            g_ibuf[icount++] = (uint16_t)i;
        }
    }

    if (icount <= 0) return;

    if (g_mv_top == 0 && g_depth_test && (g_proj_stack[g_proj_top][11] != 0.0f)) {
        memcpy(g_world_mvp, g_mvp, sizeof(g_world_mvp));
        g_has_world_mvp = 1;
    }

    sync_gl_state();
    js_gl_draw(
        draw_mode,
        g_vbuf, g_imm_count,
        g_ibuf, icount,
        g_mvp, g_mv_stack[g_mv_top],
        g_tmu[0].bound_tex, g_tmu[1].bound_tex,
        g_tmu[0].tex_2d_enabled, g_tmu[1].tex_2d_enabled,
        g_tmu[0].tex_env, g_tmu[1].tex_env,
        g_alpha_test_enabled, g_alpha_func, g_alpha_ref,
        g_clip_plane_enabled, g_clip_plane
    );
}

static void APIENTRY impl_glMatrixMode(GLenum mode) {
    g_matrix_mode = mode;
}

static void APIENTRY impl_glLoadIdentity(void) {
    mat4_identity(current_matrix());
    g_mvp_dirty = 1;
}

static void APIENTRY impl_glLoadMatrixf(const GLfloat *m) {
    if (m) {
        memcpy(current_matrix(), m, 16 * sizeof(float));
        g_mvp_dirty = 1;
    }
}

static void APIENTRY impl_glOrtho(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top, GLdouble zNear, GLdouble zFar) {
    float m[16];
    mat4_identity(m);
    float rl = (float)(right - left);
    float tb = (float)(top - bottom);
    float fn = (float)(zFar - zNear);
    if (rl != 0.0f && tb != 0.0f && fn != 0.0f) {
        m[0] = 2.0f / rl;
        m[5] = 2.0f / tb;
        m[10] = -2.0f / fn;
        m[12] = -(float)(right + left) / rl;
        m[13] = -(float)(top + bottom) / tb;
        m[14] = -(float)(zFar + zNear) / fn;
    }
    float *cur = current_matrix();
    mat4_mul(cur, cur, m);
    g_mvp_dirty = 1;
}

static void APIENTRY impl_glTranslatef(GLfloat x, GLfloat y, GLfloat z) {
    float m[16];
    mat4_identity(m);
    m[12] = x;
    m[13] = y;
    m[14] = z;
    float *cur = current_matrix();
    mat4_mul(cur, cur, m);
    g_mvp_dirty = 1;
}

static void APIENTRY impl_glPushMatrix(void) {
    if (g_matrix_mode == GL_PROJECTION) {
        if (g_proj_top < 7) {
            memcpy(g_proj_stack[g_proj_top + 1], g_proj_stack[g_proj_top], 64);
            g_proj_top++;
        }
    } else if (g_matrix_mode == GL_TEXTURE) {
        if (g_tex_top < 3) {
            memcpy(g_tex_stack[g_tex_top + 1], g_tex_stack[g_tex_top], 64);
            g_tex_top++;
        }
    } else {
        if (g_mv_top < 15) {
            memcpy(g_mv_stack[g_mv_top + 1], g_mv_stack[g_mv_top], 64);
            g_mv_top++;
        }
    }
}

static void APIENTRY impl_glPopMatrix(void) {
    if (g_matrix_mode == GL_PROJECTION) {
        if (g_proj_top > 0) g_proj_top--;
    } else if (g_matrix_mode == GL_TEXTURE) {
        if (g_tex_top > 0) g_tex_top--;
    } else {
        if (g_mv_top > 0) g_mv_top--;
    }
    g_mvp_dirty = 1;
}

static void APIENTRY impl_glViewport(GLint x, GLint y, GLsizei width, GLsizei height) {
    g_viewport_box[0] = x;
    g_viewport_box[1] = y;
    g_viewport_box[2] = width;
    g_viewport_box[3] = height;
    js_gl_viewport(x, y, width, height);
}

static void APIENTRY impl_glScissor(GLint x, GLint y, GLsizei width, GLsizei height) {
    g_scissor_box[0] = x;
    g_scissor_box[1] = y;
    g_scissor_box[2] = width;
    g_scissor_box[3] = height;
    js_gl_scissor(g_scissor_enabled, x, y, width, height);
}

static void APIENTRY impl_glPolygonMode(GLenum face, GLenum mode) {
    (void)face;
    g_polygon_mode = mode;
}

static void APIENTRY impl_glPolygonOffset(GLfloat factor, GLfloat units) {
    g_poly_factor = factor;
    g_poly_units = units;
    g_state_dirty = 1;
}

static void APIENTRY impl_glTexEnvf(GLenum target, GLenum pname, GLfloat param) {
    (void)target;
    if (pname == GL_TEXTURE_ENV_MODE) {
        g_tmu[g_active_tmu].tex_env = (int)param;
    }
}

static void APIENTRY impl_glTexImage2D(GLenum target, GLint level, GLint internalformat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const GLvoid *pixels) {
    (void)target; (void)border; (void)format; (void)type;
    js_gl_tex_image_2d(g_tmu[g_active_tmu].bound_tex, level, internalformat, width, height, pixels);
}

static void APIENTRY impl_glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels) {
    (void)target; (void)format; (void)type;
    js_gl_tex_sub_image_2d(g_tmu[g_active_tmu].bound_tex, level, xoffset, yoffset, width, height, pixels);
}

static void APIENTRY impl_glTexParameterf(GLenum target, GLenum pname, GLfloat param) {
    (void)target;
    js_gl_tex_parameter(g_tmu[g_active_tmu].bound_tex, pname, (int)param);
}

static void APIENTRY impl_glTexParameterfv(GLenum target, GLenum pname, const GLfloat *params) {
    (void)target;
    if (params) {
        js_gl_tex_parameter(g_tmu[g_active_tmu].bound_tex, pname, (int)params[0]);
    }
}

static void APIENTRY impl_glGetIntegerv(GLenum pname, GLint *params) {
    if (!params) return;
    switch (pname) {
        case GL_MAX_TEXTURE_SIZE: *params = 2048; break;
        case GL_MAX_ACTIVE_TEXTURES_ARB: *params = 2; break;
        case GL_RED_BITS:
        case GL_GREEN_BITS:
        case GL_BLUE_BITS:
        case GL_ALPHA_BITS:
            *params = 8;
            break;
        case GL_DEPTH_BITS: *params = 24; break;
        case GL_STENCIL_BITS: *params = 8; break;
        default: *params = 0; break;
    }
}

static const GLubyte * APIENTRY impl_glGetString(GLenum name) {
    switch (name) {
        case GL_VENDOR: return (const GLubyte *)"WebAssembly WebGL2";
        case GL_RENDERER: return (const GLubyte *)"Quake III Arena WebGL2";
        case GL_VERSION: return (const GLubyte *)"OpenGL 1.4 WebGL2";
        case GL_EXTENSIONS: return (const GLubyte *)"GL_ARB_multitexture GL_EXT_texture_env_add GL_EXT_compiled_vertex_array";
        default: return (const GLubyte *)"";
    }
}

static GLenum APIENTRY impl_glGetError(void) { return (GLenum)js_gl_get_error(); }
static void APIENTRY impl_glFinish(void) {}
static void APIENTRY impl_glFlush(void) {}
static void APIENTRY impl_glDrawBuffer(GLenum mode) { (void)mode; }
static void APIENTRY impl_glLineWidth(GLfloat width) { (void)width; }
static void APIENTRY impl_glShadeModel(GLenum mode) { (void)mode; }
static void APIENTRY impl_glStencilFunc(GLenum func, GLint ref, GLuint mask) { js_gl_stencil_func(func, ref, mask); }
static void APIENTRY impl_glStencilMask(GLuint mask) { js_gl_stencil_mask(mask); }
static void APIENTRY impl_glStencilOp(GLenum fail, GLenum zfail, GLenum zpass) { js_gl_stencil_op(fail, zfail, zpass); }
static void APIENTRY impl_glCallList(GLuint list) { (void)list; }
static void APIENTRY impl_glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, GLvoid *pixels) {
    if (pixels && width > 0 && height > 0)
        js_gl_read_pixels(x, y, width, height, format, type, pixels);
}

/* =========================================================================
 * QGL Function Pointer Definitions
 * ========================================================================= */
void ( APIENTRY * qglAccum )(GLenum op, GLfloat value);
void ( APIENTRY * qglAlphaFunc )(GLenum func, GLclampf ref);
GLboolean ( APIENTRY * qglAreTexturesResident )(GLsizei n, const GLuint *textures, GLboolean *residences);
void ( APIENTRY * qglArrayElement )(GLint i);
void ( APIENTRY * qglBegin )(GLenum mode);
void ( APIENTRY * qglBindTexture )(GLenum target, GLuint texture);
void ( APIENTRY * qglBitmap )(GLsizei width, GLsizei height, GLfloat xorig, GLfloat yorig, GLfloat xmove, GLfloat ymove, const GLubyte *bitmap);
void ( APIENTRY * qglBlendFunc )(GLenum sfactor, GLenum dfactor);
void ( APIENTRY * qglCallList )(GLuint list);
void ( APIENTRY * qglCallLists )(GLsizei n, GLenum type, const GLvoid *lists);
void ( APIENTRY * qglClear )(GLbitfield mask);
void ( APIENTRY * qglClearAccum )(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha);
void ( APIENTRY * qglClearColor )(GLclampf red, GLclampf green, GLclampf blue, GLclampf alpha);
void ( APIENTRY * qglClearDepth )(GLclampd depth);
void ( APIENTRY * qglClearIndex )(GLfloat c);
void ( APIENTRY * qglClearStencil )(GLint s);
void ( APIENTRY * qglClipPlane )(GLenum plane, const GLdouble *equation);
void ( APIENTRY * qglColor3b )(GLbyte red, GLbyte green, GLbyte blue);
void ( APIENTRY * qglColor3bv )(const GLbyte *v);
void ( APIENTRY * qglColor3d )(GLdouble red, GLdouble green, GLdouble blue);
void ( APIENTRY * qglColor3dv )(const GLdouble *v);
void ( APIENTRY * qglColor3f )(GLfloat red, GLfloat green, GLfloat blue);
void ( APIENTRY * qglColor3fv )(const GLfloat *v);
void ( APIENTRY * qglColor3i )(GLint red, GLint green, GLint blue);
void ( APIENTRY * qglColor3iv )(const GLint *v);
void ( APIENTRY * qglColor3s )(GLshort red, GLshort green, GLshort blue);
void ( APIENTRY * qglColor3sv )(const GLshort *v);
void ( APIENTRY * qglColor3ub )(GLubyte red, GLubyte green, GLubyte blue);
void ( APIENTRY * qglColor3ubv )(const GLubyte *v);
void ( APIENTRY * qglColor3ui )(GLuint red, GLuint green, GLuint blue);
void ( APIENTRY * qglColor3uiv )(const GLuint *v);
void ( APIENTRY * qglColor3us )(GLushort red, GLushort green, GLushort blue);
void ( APIENTRY * qglColor3usv )(const GLushort *v);
void ( APIENTRY * qglColor4b )(GLbyte red, GLbyte green, GLbyte blue, GLbyte alpha);
void ( APIENTRY * qglColor4bv )(const GLbyte *v);
void ( APIENTRY * qglColor4d )(GLdouble red, GLdouble green, GLdouble blue, GLdouble alpha);
void ( APIENTRY * qglColor4dv )(const GLdouble *v);
void ( APIENTRY * qglColor4f )(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha);
void ( APIENTRY * qglColor4fv )(const GLfloat *v);
void ( APIENTRY * qglColor4i )(GLint red, GLint green, GLint blue, GLint alpha);
void ( APIENTRY * qglColor4iv )(const GLint *v);
void ( APIENTRY * qglColor4s )(GLshort red, GLshort green, GLshort blue, GLshort alpha);
void ( APIENTRY * qglColor4sv )(const GLshort *v);
void ( APIENTRY * qglColor4ub )(GLubyte red, GLubyte green, GLubyte blue, GLubyte alpha);
void ( APIENTRY * qglColor4ubv )(const GLubyte *v);
void ( APIENTRY * qglColor4ui )(GLuint red, GLuint green, GLuint blue, GLuint alpha);
void ( APIENTRY * qglColor4uiv )(const GLuint *v);
void ( APIENTRY * qglColor4us )(GLushort red, GLushort green, GLushort blue, GLushort alpha);
void ( APIENTRY * qglColor4usv )(const GLushort *v);
void ( APIENTRY * qglColorMask )(GLboolean red, GLboolean green, GLboolean blue, GLboolean alpha);
void ( APIENTRY * qglColorMaterial )(GLenum face, GLenum mode);
void ( APIENTRY * qglColorPointer )(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglCopyPixels )(GLint x, GLint y, GLsizei width, GLsizei height, GLenum type);
void ( APIENTRY * qglCopyTexImage1D )(GLenum target, GLint level, GLenum internalFormat, GLint x, GLint y, GLsizei width, GLint border);
void ( APIENTRY * qglCopyTexImage2D )(GLenum target, GLint level, GLenum internalFormat, GLint x, GLint y, GLsizei width, GLsizei height, GLint border);
void ( APIENTRY * qglCopyTexSubImage1D )(GLenum target, GLint level, GLint xoffset, GLint x, GLint y, GLsizei width);
void ( APIENTRY * qglCopyTexSubImage2D )(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLint x, GLint y, GLsizei width, GLsizei height);
void ( APIENTRY * qglCullFace )(GLenum mode);
void ( APIENTRY * qglDeleteLists )(GLuint list, GLsizei range);
void ( APIENTRY * qglDeleteTextures )(GLsizei n, const GLuint *textures);
void ( APIENTRY * qglDepthFunc )(GLenum func);
void ( APIENTRY * qglDepthMask )(GLboolean flag);
void ( APIENTRY * qglDepthRange )(GLclampd zNear, GLclampd zFar);
void ( APIENTRY * qglDisable )(GLenum cap);
void ( APIENTRY * qglDisableClientState )(GLenum array);
void ( APIENTRY * qglDrawArrays )(GLenum mode, GLint first, GLsizei count);
void ( APIENTRY * qglDrawBuffer )(GLenum mode);
void ( APIENTRY * qglDrawElements )(GLenum mode, GLsizei count, GLenum type, const GLvoid *indices);
void ( APIENTRY * qglDrawPixels )(GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels);
void ( APIENTRY * qglEdgeFlag )(GLboolean flag);
void ( APIENTRY * qglEdgeFlagPointer )(GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglEdgeFlagv )(const GLboolean *flag);
void ( APIENTRY * qglEnable )(GLenum cap);
void ( APIENTRY * qglEnableClientState )(GLenum array);
void ( APIENTRY * qglEnd )(void);
void ( APIENTRY * qglEndList )(void);
void ( APIENTRY * qglEvalCoord1d )(GLdouble u);
void ( APIENTRY * qglEvalCoord1dv )(const GLdouble *u);
void ( APIENTRY * qglEvalCoord1f )(GLfloat u);
void ( APIENTRY * qglEvalCoord1fv )(const GLfloat *u);
void ( APIENTRY * qglEvalCoord2d )(GLdouble u, GLdouble v);
void ( APIENTRY * qglEvalCoord2dv )(const GLdouble *u);
void ( APIENTRY * qglEvalCoord2f )(GLfloat u, GLfloat v);
void ( APIENTRY * qglEvalCoord2fv )(const GLfloat *u);
void ( APIENTRY * qglEvalMesh1 )(GLenum mode, GLint i1, GLint i2);
void ( APIENTRY * qglEvalMesh2 )(GLenum mode, GLint i1, GLint i2, GLint j1, GLint j2);
void ( APIENTRY * qglEvalPoint1 )(GLint i);
void ( APIENTRY * qglEvalPoint2 )(GLint i, GLint j);
void ( APIENTRY * qglFeedbackBuffer )(GLsizei size, GLenum type, GLfloat *buffer);
void ( APIENTRY * qglFinish )(void);
void ( APIENTRY * qglFlush )(void);
void ( APIENTRY * qglFogf )(GLenum pname, GLfloat param);
void ( APIENTRY * qglFogfv )(GLenum pname, const GLfloat *params);
void ( APIENTRY * qglFogi )(GLenum pname, GLint param);
void ( APIENTRY * qglFogiv )(GLenum pname, const GLint *params);
void ( APIENTRY * qglFrontFace )(GLenum mode);
void ( APIENTRY * qglFrustum )(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top, GLdouble zNear, GLdouble zFar);
GLuint ( APIENTRY * qglGenLists )(GLsizei range);
void ( APIENTRY * qglGenTextures )(GLsizei n, GLuint *textures);
void ( APIENTRY * qglGetBooleanv )(GLenum pname, GLboolean *params);
void ( APIENTRY * qglGetClipPlane )(GLenum plane, GLdouble *equation);
void ( APIENTRY * qglGetDoublev )(GLenum pname, GLdouble *params);
GLenum ( APIENTRY * qglGetError )(void);
void ( APIENTRY * qglGetFloatv )(GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetIntegerv )(GLenum pname, GLint *params);
void ( APIENTRY * qglGetLightfv )(GLenum light, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetLightiv )(GLenum light, GLenum pname, GLint *params);
void ( APIENTRY * qglGetMapdv )(GLenum target, GLenum query, GLdouble *v);
void ( APIENTRY * qglGetMapfv )(GLenum target, GLenum query, GLfloat *v);
void ( APIENTRY * qglGetMapiv )(GLenum target, GLenum query, GLint *v);
void ( APIENTRY * qglGetMaterialfv )(GLenum face, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetMaterialiv )(GLenum face, GLenum pname, GLint *params);
void ( APIENTRY * qglGetPixelMapfv )(GLenum map, GLfloat *values);
void ( APIENTRY * qglGetPixelMapuiv )(GLenum map, GLuint *values);
void ( APIENTRY * qglGetPixelMapusv )(GLenum map, GLushort *values);
void ( APIENTRY * qglGetPointerv )(GLenum pname, GLvoid* *params);
void ( APIENTRY * qglGetPolygonStipple )(GLubyte *mask);
const GLubyte * ( APIENTRY * qglGetString )(GLenum name);
void ( APIENTRY * qglGetTexEnvfv )(GLenum target, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetTexEnviv )(GLenum target, GLenum pname, GLint *params);
void ( APIENTRY * qglGetTexGendv )(GLenum coord, GLenum pname, GLdouble *params);
void ( APIENTRY * qglGetTexGenfv )(GLenum coord, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetTexGeniv )(GLenum coord, GLenum pname, GLint *params);
void ( APIENTRY * qglGetTexImage )(GLenum target, GLint level, GLenum format, GLenum type, GLvoid *pixels);
void ( APIENTRY * qglGetTexLevelParameterfv )(GLenum target, GLint level, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetTexLevelParameteriv )(GLenum target, GLint level, GLenum pname, GLint *params);
void ( APIENTRY * qglGetTexParameterfv )(GLenum target, GLenum pname, GLfloat *params);
void ( APIENTRY * qglGetTexParameteriv )(GLenum target, GLenum pname, GLint *params);
void ( APIENTRY * qglHint )(GLenum target, GLenum mode);
void ( APIENTRY * qglIndexMask )(GLuint mask);
void ( APIENTRY * qglIndexPointer )(GLenum type, GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglIndexd )(GLdouble c);
void ( APIENTRY * qglIndexdv )(const GLdouble *c);
void ( APIENTRY * qglIndexf )(GLfloat c);
void ( APIENTRY * qglIndexfv )(const GLfloat *c);
void ( APIENTRY * qglIndexi )(GLint c);
void ( APIENTRY * qglIndexiv )(const GLint *c);
void ( APIENTRY * qglIndexs )(GLshort c);
void ( APIENTRY * qglIndexsv )(const GLshort *c);
void ( APIENTRY * qglIndexub )(GLubyte c);
void ( APIENTRY * qglIndexubv )(const GLubyte *c);
void ( APIENTRY * qglInitNames )(void);
void ( APIENTRY * qglInterleavedArrays )(GLenum format, GLsizei stride, const GLvoid *pointer);
GLboolean ( APIENTRY * qglIsEnabled )(GLenum cap);
GLboolean ( APIENTRY * qglIsList )(GLuint list);
GLboolean ( APIENTRY * qglIsTexture )(GLuint texture);
void ( APIENTRY * qglLightModelf )(GLenum pname, GLfloat param);
void ( APIENTRY * qglLightModelfv )(GLenum pname, const GLfloat *params);
void ( APIENTRY * qglLightModeli )(GLenum pname, GLint param);
void ( APIENTRY * qglLightModeliv )(GLenum pname, const GLint *params);
void ( APIENTRY * qglLightf )(GLenum light, GLenum pname, GLfloat param);
void ( APIENTRY * qglLightfv )(GLenum light, GLenum pname, const GLfloat *params);
void ( APIENTRY * qglLighti )(GLenum light, GLenum pname, GLint param);
void ( APIENTRY * qglLightiv )(GLenum light, GLenum pname, const GLint *params);
void ( APIENTRY * qglLineStipple )(GLint factor, GLushort pattern);
void ( APIENTRY * qglLineWidth )(GLfloat width);
void ( APIENTRY * qglListBase )(GLuint base);
void ( APIENTRY * qglLoadIdentity )(void);
void ( APIENTRY * qglLoadMatrixd )(const GLdouble *m);
void ( APIENTRY * qglLoadMatrixf )(const GLfloat *m);
void ( APIENTRY * qglLoadName )(GLuint name);
void ( APIENTRY * qglLogicOp )(GLenum opcode);
void ( APIENTRY * qglMap1d )(GLenum target, GLdouble u1, GLdouble u2, GLint stride, GLint order, const GLdouble *points);
void ( APIENTRY * qglMap1f )(GLenum target, GLfloat u1, GLfloat u2, GLint stride, GLint order, const GLfloat *points);
void ( APIENTRY * qglMap2d )(GLenum target, GLdouble u1, GLdouble u2, GLint ustride, GLint uorder, GLdouble v1, GLdouble v2, GLint vstride, GLint vorder, const GLdouble *points);
void ( APIENTRY * qglMap2f )(GLenum target, GLfloat u1, GLfloat u2, GLint ustride, GLint uorder, GLfloat v1, GLfloat v2, GLint vstride, GLint vorder, const GLfloat *points);
void ( APIENTRY * qglMapGrid1d )(GLint un, GLdouble u1, GLdouble u2);
void ( APIENTRY * qglMapGrid1f )(GLint un, GLfloat u1, GLfloat u2);
void ( APIENTRY * qglMapGrid2d )(GLint un, GLdouble u1, GLdouble u2, GLint vn, GLdouble v1, GLdouble v2);
void ( APIENTRY * qglMapGrid2f )(GLint un, GLfloat u1, GLfloat u2, GLint vn, GLfloat v1, GLfloat v2);
void ( APIENTRY * qglMaterialf )(GLenum face, GLenum pname, GLfloat param);
void ( APIENTRY * qglMaterialfv )(GLenum face, GLenum pname, const GLfloat *params);
void ( APIENTRY * qglMateriali )(GLenum face, GLenum pname, GLint param);
void ( APIENTRY * qglMaterialiv )(GLenum face, GLenum pname, const GLint *params);
void ( APIENTRY * qglMatrixMode )(GLenum mode);
void ( APIENTRY * qglMultMatrixd )(const GLdouble *m);
void ( APIENTRY * qglMultMatrixf )(const GLfloat *m);
void ( APIENTRY * qglNewList )(GLuint list, GLenum mode);
void ( APIENTRY * qglNormal3b )(GLbyte nx, GLbyte ny, GLbyte nz);
void ( APIENTRY * qglNormal3bv )(const GLbyte *v);
void ( APIENTRY * qglNormal3d )(GLdouble nx, GLdouble ny, GLdouble nz);
void ( APIENTRY * qglNormal3dv )(const GLdouble *v);
void ( APIENTRY * qglNormal3f )(GLfloat nx, GLfloat ny, GLfloat nz);
void ( APIENTRY * qglNormal3fv )(const GLfloat *v);
void ( APIENTRY * qglNormal3i )(GLint nx, GLint ny, GLint nz);
void ( APIENTRY * qglNormal3iv )(const GLint *v);
void ( APIENTRY * qglNormal3s )(GLshort nx, GLshort ny, GLshort nz);
void ( APIENTRY * qglNormal3sv )(const GLshort *v);
void ( APIENTRY * qglNormalPointer )(GLenum type, GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglOrtho )(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top, GLdouble zNear, GLdouble zFar);
void ( APIENTRY * qglPassThrough )(GLfloat token);
void ( APIENTRY * qglPixelMapfv )(GLenum map, GLsizei mapsize, const GLfloat *values);
void ( APIENTRY * qglPixelMapuiv )(GLenum map, GLsizei mapsize, const GLuint *values);
void ( APIENTRY * qglPixelMapusv )(GLenum map, GLsizei mapsize, const GLushort *values);
void ( APIENTRY * qglPixelStoref )(GLenum pname, GLfloat param);
void ( APIENTRY * qglPixelStorei )(GLenum pname, GLint param);
void ( APIENTRY * qglPixelTransferf )(GLenum pname, GLfloat param);
void ( APIENTRY * qglPixelTransferi )(GLenum pname, GLint param);
void ( APIENTRY * qglPixelZoom )(GLfloat xfactor, GLfloat yfactor);
void ( APIENTRY * qglPointSize )(GLfloat size);
void ( APIENTRY * qglPolygonMode )(GLenum face, GLenum mode);
void ( APIENTRY * qglPolygonOffset )(GLfloat factor, GLfloat units);
void ( APIENTRY * qglPolygonStipple )(const GLubyte *mask);
void ( APIENTRY * qglPopAttrib )(void);
void ( APIENTRY * qglPopClientAttrib )(void);
void ( APIENTRY * qglPopMatrix )(void);
void ( APIENTRY * qglPopName )(void);
void ( APIENTRY * qglPrioritizeTextures )(GLsizei n, const GLuint *textures, const GLclampf *priorities);
void ( APIENTRY * qglPushAttrib )(GLbitfield mask);
void ( APIENTRY * qglPushClientAttrib )(GLbitfield mask);
void ( APIENTRY * qglPushMatrix )(void);
void ( APIENTRY * qglPushName )(GLuint name);
void ( APIENTRY * qglRasterPos2d )(GLdouble x, GLdouble y);
void ( APIENTRY * qglRasterPos2dv )(const GLdouble *v);
void ( APIENTRY * qglRasterPos2f )(GLfloat x, GLfloat y);
void ( APIENTRY * qglRasterPos2fv )(const GLfloat *v);
void ( APIENTRY * qglRasterPos2i )(GLint x, GLint y);
void ( APIENTRY * qglRasterPos2iv )(const GLint *v);
void ( APIENTRY * qglRasterPos2s )(GLshort x, GLshort y);
void ( APIENTRY * qglRasterPos2sv )(const GLshort *v);
void ( APIENTRY * qglRasterPos3d )(GLdouble x, GLdouble y, GLdouble z);
void ( APIENTRY * qglRasterPos3dv )(const GLdouble *v);
void ( APIENTRY * qglRasterPos3f )(GLfloat x, GLfloat y, GLfloat z);
void ( APIENTRY * qglRasterPos3fv )(const GLfloat *v);
void ( APIENTRY * qglRasterPos3i )(GLint x, GLint y, GLint z);
void ( APIENTRY * qglRasterPos3iv )(const GLint *v);
void ( APIENTRY * qglRasterPos3s )(GLshort x, GLshort y, GLshort z);
void ( APIENTRY * qglRasterPos3sv )(const GLshort *v);
void ( APIENTRY * qglRasterPos4d )(GLdouble x, GLdouble y, GLdouble z, GLdouble w);
void ( APIENTRY * qglRasterPos4dv )(const GLdouble *v);
void ( APIENTRY * qglRasterPos4f )(GLfloat x, GLfloat y, GLfloat z, GLfloat w);
void ( APIENTRY * qglRasterPos4fv )(const GLfloat *v);
void ( APIENTRY * qglRasterPos4i )(GLint x, GLint y, GLint z, GLint w);
void ( APIENTRY * qglRasterPos4iv )(const GLint *v);
void ( APIENTRY * qglRasterPos4s )(GLshort x, GLshort y, GLshort z, GLshort w);
void ( APIENTRY * qglRasterPos4sv )(const GLshort *v);
void ( APIENTRY * qglReadBuffer )(GLenum mode);
void ( APIENTRY * qglReadPixels )(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, GLvoid *pixels);
void ( APIENTRY * qglRectd )(GLdouble x1, GLdouble y1, GLdouble x2, GLdouble y2);
void ( APIENTRY * qglRectdv )(const GLdouble *v1, const GLdouble *v2);
void ( APIENTRY * qglRectf )(GLfloat x1, GLfloat y1, GLfloat x2, GLfloat y2);
void ( APIENTRY * qglRectfv )(const GLfloat *v1, const GLfloat *v2);
void ( APIENTRY * qglRecti )(GLint x1, GLint y1, GLint x2, GLint y2);
void ( APIENTRY * qglRectiv )(const GLint *v1, const GLint *v2);
void ( APIENTRY * qglRects )(GLshort x1, GLshort y1, GLshort x2, GLshort y2);
void ( APIENTRY * qglRectsv )(const GLshort *v1, const GLshort *v2);
GLint ( APIENTRY * qglRenderMode )(GLenum mode);
void ( APIENTRY * qglRotated )(GLdouble angle, GLdouble x, GLdouble y, GLdouble z);
void ( APIENTRY * qglRotatef )(GLfloat angle, GLfloat x, GLfloat y, GLfloat z);
void ( APIENTRY * qglScaled )(GLdouble x, GLdouble y, GLdouble z);
void ( APIENTRY * qglScalef )(GLfloat x, GLfloat y, GLfloat z);
void ( APIENTRY * qglScissor )(GLint x, GLint y, GLsizei width, GLsizei height);
void ( APIENTRY * qglSelectBuffer )(GLsizei size, GLuint *buffer);
void ( APIENTRY * qglShadeModel )(GLenum mode);
void ( APIENTRY * qglStencilFunc )(GLenum func, GLint ref, GLuint mask);
void ( APIENTRY * qglStencilMask )(GLuint mask);
void ( APIENTRY * qglStencilOp )(GLenum fail, GLenum zfail, GLenum zpass);
void ( APIENTRY * qglTexCoord1d )(GLdouble s);
void ( APIENTRY * qglTexCoord1dv )(const GLdouble *v);
void ( APIENTRY * qglTexCoord1f )(GLfloat s);
void ( APIENTRY * qglTexCoord1fv )(const GLfloat *v);
void ( APIENTRY * qglTexCoord1i )(GLint s);
void ( APIENTRY * qglTexCoord1iv )(const GLint *v);
void ( APIENTRY * qglTexCoord1s )(GLshort s);
void ( APIENTRY * qglTexCoord1sv )(const GLshort *v);
void ( APIENTRY * qglTexCoord2d )(GLdouble s, GLdouble t);
void ( APIENTRY * qglTexCoord2dv )(const GLdouble *v);
void ( APIENTRY * qglTexCoord2f )(GLfloat s, GLfloat t);
void ( APIENTRY * qglTexCoord2fv )(const GLfloat *v);
void ( APIENTRY * qglTexCoord2i )(GLint s, GLint t);
void ( APIENTRY * qglTexCoord2iv )(const GLint *v);
void ( APIENTRY * qglTexCoord2s )(GLshort s, GLshort t);
void ( APIENTRY * qglTexCoord2sv )(const GLshort *v);
void ( APIENTRY * qglTexCoord3d )(GLdouble s, GLdouble t, GLdouble r);
void ( APIENTRY * qglTexCoord3dv )(const GLdouble *v);
void ( APIENTRY * qglTexCoord3f )(GLfloat s, GLfloat t, GLfloat r);
void ( APIENTRY * qglTexCoord3fv )(const GLfloat *v);
void ( APIENTRY * qglTexCoord3i )(GLint s, GLint t, GLint r);
void ( APIENTRY * qglTexCoord3iv )(const GLint *v);
void ( APIENTRY * qglTexCoord3s )(GLshort s, GLshort t, GLshort r);
void ( APIENTRY * qglTexCoord3sv )(const GLshort *v);
void ( APIENTRY * qglTexCoord4d )(GLdouble s, GLdouble t, GLdouble r, GLdouble q);
void ( APIENTRY * qglTexCoord4dv )(const GLdouble *v);
void ( APIENTRY * qglTexCoord4f )(GLfloat s, GLfloat t, GLfloat r, GLfloat q);
void ( APIENTRY * qglTexCoord4fv )(const GLfloat *v);
void ( APIENTRY * qglTexCoord4i )(GLint s, GLint t, GLint r, GLint q);
void ( APIENTRY * qglTexCoord4iv )(const GLint *v);
void ( APIENTRY * qglTexCoord4s )(GLshort s, GLshort t, GLshort r, GLshort q);
void ( APIENTRY * qglTexCoord4sv )(const GLshort *v);
void ( APIENTRY * qglTexCoordPointer )(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglTexEnvf )(GLenum target, GLenum pname, GLfloat param);
void ( APIENTRY * qglTexEnvfv )(GLenum target, GLenum pname, const GLfloat *params);
void ( APIENTRY * qglTexEnvi )(GLenum target, GLenum pname, GLint param);
void ( APIENTRY * qglTexEnviv )(GLenum target, GLenum pname, const GLint *params);
void ( APIENTRY * qglTexGend )(GLenum coord, GLenum pname, GLdouble param);
void ( APIENTRY * qglTexGendv )(GLenum coord, GLenum pname, const GLdouble *params);
void ( APIENTRY * qglTexGenf )(GLenum coord, GLenum pname, GLfloat param);
void ( APIENTRY * qglTexGenfv )(GLenum coord, GLenum pname, const GLfloat *params);
void ( APIENTRY * qglTexGeni )(GLenum coord, GLenum pname, GLint param);
void ( APIENTRY * qglTexGeniv )(GLenum coord, GLenum pname, const GLint *params);
void ( APIENTRY * qglTexImage1D )(GLenum target, GLint level, GLint internalformat, GLsizei width, GLint border, GLenum format, GLenum type, const GLvoid *pixels);
void ( APIENTRY * qglTexImage2D )(GLenum target, GLint level, GLint internalformat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const GLvoid *pixels);
void ( APIENTRY * qglTexParameterf )(GLenum target, GLenum pname, GLfloat param);
void ( APIENTRY * qglTexParameterfv )(GLenum target, GLenum pname, const GLfloat *params);
void ( APIENTRY * qglTexParameteri )(GLenum target, GLenum pname, GLint param);
void ( APIENTRY * qglTexParameteriv )(GLenum target, GLenum pname, const GLint *params);
void ( APIENTRY * qglTexSubImage1D )(GLenum target, GLint level, GLint xoffset, GLsizei width, GLenum format, GLenum type, const GLvoid *pixels);
void ( APIENTRY * qglTexSubImage2D )(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels);
void ( APIENTRY * qglTranslated )(GLdouble x, GLdouble y, GLdouble z);
void ( APIENTRY * qglTranslatef )(GLfloat x, GLfloat y, GLfloat z);
void ( APIENTRY * qglVertex2d )(GLdouble x, GLdouble y);
void ( APIENTRY * qglVertex2dv )(const GLdouble *v);
void ( APIENTRY * qglVertex2f )(GLfloat x, GLfloat y);
void ( APIENTRY * qglVertex2fv )(const GLfloat *v);
void ( APIENTRY * qglVertex2i )(GLint x, GLint y);
void ( APIENTRY * qglVertex2iv )(const GLint *v);
void ( APIENTRY * qglVertex2s )(GLshort x, GLshort y);
void ( APIENTRY * qglVertex2sv )(const GLshort *v);
void ( APIENTRY * qglVertex3d )(GLdouble x, GLdouble y, GLdouble z);
void ( APIENTRY * qglVertex3dv )(const GLdouble *v);
void ( APIENTRY * qglVertex3f )(GLfloat x, GLfloat y, GLfloat z);
void ( APIENTRY * qglVertex3fv )(const GLfloat *v);
void ( APIENTRY * qglVertex3i )(GLint x, GLint y, GLint z);
void ( APIENTRY * qglVertex3iv )(const GLint *v);
void ( APIENTRY * qglVertex3s )(GLshort x, GLshort y, GLshort z);
void ( APIENTRY * qglVertex3sv )(const GLshort *v);
void ( APIENTRY * qglVertex4d )(GLdouble x, GLdouble y, GLdouble z, GLdouble w);
void ( APIENTRY * qglVertex4dv )(const GLdouble *v);
void ( APIENTRY * qglVertex4f )(GLfloat x, GLfloat y, GLfloat z, GLfloat w);
void ( APIENTRY * qglVertex4fv )(const GLfloat *v);
void ( APIENTRY * qglVertex4i )(GLint x, GLint y, GLint z, GLint w);
void ( APIENTRY * qglVertex4iv )(const GLint *v);
void ( APIENTRY * qglVertex4s )(GLshort x, GLshort y, GLshort z, GLshort w);
void ( APIENTRY * qglVertex4sv )(const GLshort *v);
void ( APIENTRY * qglVertexPointer )(GLint size, GLenum type, GLsizei stride, const GLvoid *pointer);
void ( APIENTRY * qglViewport )(GLint x, GLint y, GLsizei width, GLsizei height);

qboolean QGL_Init(const char *dllname) {
    (void)dllname;
    qglActiveTextureARB = impl_glActiveTextureARB;
    qglClientActiveTextureARB = impl_glClientActiveTextureARB;
    qglMultiTexCoord2fARB = impl_glMultiTexCoord2fARB;
    qglLockArraysEXT = impl_glLockArraysEXT;
    qglUnlockArraysEXT = impl_glUnlockArraysEXT;

    qglAlphaFunc = impl_glAlphaFunc;
    qglArrayElement = impl_glArrayElement;
    qglBegin = impl_glBegin;
    qglBindTexture = impl_glBindTexture;
    qglBlendFunc = impl_glBlendFunc;
    qglCallList = impl_glCallList;
    qglClear = impl_glClear;
    qglClearColor = impl_glClearColor;
    qglClearDepth = impl_glClearDepth;
    qglClearStencil = impl_glClearStencil;
    qglClipPlane = impl_glClipPlane;
    qglColor3f = impl_glColor3f;
    qglColor4f = impl_glColor4f;
    qglColor4ubv = impl_glColor4ubv;
    qglColorMask = impl_glColorMask;
    qglColorPointer = impl_glColorPointer;
    qglCullFace = impl_glCullFace;
    qglDeleteTextures = impl_glDeleteTextures;
    qglDepthFunc = impl_glDepthFunc;
    qglDepthMask = impl_glDepthMask;
    qglDepthRange = impl_glDepthRange;
    qglDisable = impl_glDisable;
    qglDisableClientState = impl_glDisableClientState;
    qglDrawBuffer = impl_glDrawBuffer;
    qglDrawElements = impl_glDrawElements;
    qglEnable = impl_glEnable;
    qglEnableClientState = impl_glEnableClientState;
    qglEnd = impl_glEnd;
    qglFinish = impl_glFinish;
    qglFlush = impl_glFlush;
    qglGetError = impl_glGetError;
    qglGetIntegerv = impl_glGetIntegerv;
    qglGetString = impl_glGetString;
    qglLineWidth = impl_glLineWidth;
    qglLoadIdentity = impl_glLoadIdentity;
    qglLoadMatrixf = impl_glLoadMatrixf;
    qglMatrixMode = impl_glMatrixMode;
    qglOrtho = impl_glOrtho;
    qglPolygonMode = impl_glPolygonMode;
    qglPolygonOffset = impl_glPolygonOffset;
    qglPopMatrix = impl_glPopMatrix;
    qglPushMatrix = impl_glPushMatrix;
    qglReadPixels = impl_glReadPixels;
    qglScissor = impl_glScissor;
    qglShadeModel = impl_glShadeModel;
    qglStencilFunc = impl_glStencilFunc;
    qglStencilMask = impl_glStencilMask;
    qglStencilOp = impl_glStencilOp;
    qglTexCoord2f = impl_glTexCoord2f;
    qglTexCoord2fv = impl_glTexCoord2fv;
    qglTexCoordPointer = impl_glTexCoordPointer;
    qglTexEnvf = impl_glTexEnvf;
    qglTexImage2D = impl_glTexImage2D;
    qglTexParameterf = impl_glTexParameterf;
    qglTexParameterfv = impl_glTexParameterfv;
    qglTexSubImage2D = impl_glTexSubImage2D;
    qglTranslatef = impl_glTranslatef;
    qglVertex2f = impl_glVertex2f;
    qglVertex3f = impl_glVertex3f;
    qglVertex3fv = impl_glVertex3fv;
    qglVertexPointer = impl_glVertexPointer;
    qglViewport = impl_glViewport;
    return qtrue;
}

void QGL_Shutdown(void) {}

void GLimp_Init(void) {
    mat4_identity(g_mv_stack[0]);
    mat4_identity(g_proj_stack[0]);
    mat4_identity(g_tex_stack[0]);
    mat4_identity(g_mvp);
    g_mv_top = 0;
    g_proj_top = 0;
    g_tex_top = 0;
    g_mvp_dirty = 1;

    memset(g_tmu, 0, sizeof(g_tmu));
    g_tmu[0].tex_env = GL_MODULATE;
    g_tmu[1].tex_env = GL_MODULATE;

    QGL_Init("webgl2");

    int w = 800, h = 600;
    js_gl_init(&w, &h);
    if (w <= 0) w = 800;
    if (h <= 0) h = 600;

    glConfig.vidWidth = w;
    glConfig.vidHeight = h;
    glConfig.windowAspect = (float)w / (float)h;
    glConfig.colorBits = 32;
    glConfig.depthBits = 24;
    glConfig.stencilBits = 8;
    glConfig.driverType = GLDRV_ICD;
    glConfig.hardwareType = GLHW_GENERIC;
    /* Browser surfaces cannot change the monitor gamma ramp. Let the
       original renderer apply its software gamma/intensity tables. */
    glConfig.deviceSupportsGamma = qfalse;
    glConfig.textureCompression = TC_NONE;
    glConfig.textureEnvAddAvailable = qtrue;
    glConfig.maxActiveTextures = 2;
    glConfig.maxTextureSize = 2048;
    glConfig.isFullscreen = qfalse;
    glConfig.stereoEnabled = qfalse;
    glConfig.smpActive = qfalse;

    Q_strncpyz(glConfig.vendor_string, (const char *)qglGetString(GL_VENDOR), sizeof(glConfig.vendor_string));
    Q_strncpyz(glConfig.renderer_string, (const char *)qglGetString(GL_RENDERER), sizeof(glConfig.renderer_string));
    Q_strncpyz(glConfig.version_string, (const char *)qglGetString(GL_VERSION), sizeof(glConfig.version_string));
    Q_strncpyz(glConfig.extensions_string, (const char *)qglGetString(GL_EXTENSIONS), sizeof(glConfig.extensions_string));
}

void GLimp_Shutdown(void) {
    QGL_Shutdown();
}

void GLimp_EndFrame(void) {
    js_gl_end_frame();
}

void GLimp_EnableLogging(qboolean enable) {
    (void)enable;
}

void GLimp_LogComment(char *comment) {
    (void)comment;
}

void GLimp_SetGamma(unsigned char red[256], unsigned char green[256], unsigned char blue[256]) {
    (void)red; (void)green; (void)blue;
}

qboolean GLimp_SpawnRenderThread(void (*function)(void)) {
    (void)function;
    return qfalse;
}

void *GLimp_RendererSleep(void) {
    return NULL;
}

void GLimp_FrontEndSleep(void) {}

void GLimp_WakeRenderer(void *data) {
    (void)data;
}
