#include "../game/q_shared.h"
#include "../qcommon/qcommon.h"
#define IMPORT(n) __attribute__((import_module("env"), import_name(#n)))
IMPORT(js_net_receive) int js_net_receive(void *data, int max);
IMPORT(js_net_peer) int js_net_peer(void);
IMPORT(js_net_send) void js_net_send(const void *data, int length, int peer);
void NET_Init(void) { Com_Printf("Network: WebSocket transport\n"); }
void NET_Shutdown(void) {}
void NET_Sleep(int msec) { (void)msec; }
void NET_Restart(void) {}
qboolean Sys_StringToAdr(const char *s, netadr_t *a) {
    int ip0,ip1,ip2,ip3; char tail;
    if (!s || !a) return qfalse;
    Com_Memset(a,0,sizeof(*a));
    if (!Q_stricmp(s,"localhost")) { a->type=NA_LOOPBACK; return qtrue; }
    if (sscanf(s,"%d.%d.%d.%d%c",&ip0,&ip1,&ip2,&ip3,&tail)!=4) return qfalse;
    if (ip0!=10 || ip1!=0 || ip2<0 || ip2>255 || ip3<0 || ip3>255 || !(ip2||ip3)) return qfalse;
    a->type=NA_IP; a->ip[0]=10; a->ip[1]=0; a->ip[2]=ip2; a->ip[3]=ip3;
    return qtrue;
}
qboolean Sys_GetPacket(netadr_t *from,msg_t *message) {
    int length=js_net_receive(message->data,message->maxsize),peer;
    if(length<=0) return qfalse;
    peer=js_net_peer();
    Com_Memset(from,0,sizeof(*from));
    from->type=NA_IP; from->ip[0]=10; from->ip[2]=(peer>>8)&255; from->ip[3]=peer&255;
    from->port=BigShort(PORT_SERVER); message->cursize=length;
    return qtrue;
}
void Sys_SendPacket(int length,const void *data,netadr_t to) {
    if(to.type==NA_IP && to.ip[0]==10 && to.ip[1]==0 && length>0 && length<=MAX_MSGLEN)
        js_net_send(data,length,(to.ip[2]<<8)|to.ip[3]);
}
qboolean Sys_IsLANAddress(netadr_t adr) { return adr.type==NA_LOOPBACK || (adr.type==NA_IP && adr.ip[0]==10 && adr.ip[1]==0); }
void Sys_ShowIP(void) { Com_Printf("WebSocket virtual network 10.0.0.0/16\n"); }
