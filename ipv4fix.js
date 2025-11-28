// ipv4fix.js
import dns from 'dns';

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
  console.log('IPv4 forzado correctamente antes de cargar módulos.');
}