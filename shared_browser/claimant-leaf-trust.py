#!/usr/bin/env python3
"""Explicit exact-leaf claimant trust; never enroll a CA or change dashboard trust.

Validators adapted from agent_trace d8a2c1e scripts/dev_browser_trust.py.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time

HOST="procbox.agent-trace.ts.net"
IP="100.89.85.103"
PIN="6771c3b6bafe0209558a4d70fceaf6ad2c8467dedee0976c1897b545a5349262"
PREFIX="dev-tools-claimant-leaf-"
NICKNAME=PREFIX+PIN
CERTIFICATE=Path(__file__).resolve().parent/"public-trust/claimant-web-server-cert.pem"
def command(args,**kwargs):
    return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=15,**kwargs)

def validate_leaf(pem,pin,now=None,check_time=True):
    if not isinstance(pin,str) or not re.fullmatch(r"[0-9a-f]{64}",pin):
        raise ValueError("invalid manifest certificate digest")
    if pem.count(b"-----BEGIN CERTIFICATE-----")!=1 or b"PRIVATE KEY" in pem:
        raise ValueError("exactly one public leaf certificate required")
    with tempfile.TemporaryDirectory(prefix="agent-trace-dev-leaf-") as temporary:
        leaf=Path(temporary)/"leaf.pem";leaf.write_bytes(pem)
        der=command(["openssl","x509","-in",str(leaf),"-outform","DER"])
        if hashlib.sha256(der).hexdigest()!=pin:raise ValueError("dev leaf fingerprint differs from reviewed manifest")
        def extension(name):
            return command(["openssl","x509","-in",str(leaf),"-noout","-ext",name],text=True)
        constraints=extension("basicConstraints")
        if "CA:FALSE" not in constraints or "CA:TRUE" in constraints:raise ValueError("CA certificates cannot be enrolled")
        values=extension("subjectAltName").splitlines()[1:]
        dns=set();ips=set()
        for item in ",".join(values).split(","):
            item=item.strip()
            if item.startswith("DNS:"):dns.add(item[4:])
            elif item.startswith("IP Address:"):ips.add(str(ipaddress.ip_address(item[11:])))
            else:raise ValueError("unsupported certificate SAN")
        if dns!={"localhost",HOST} or ips!={"127.0.0.1",IP}:
            raise ValueError("certificate SANs differ from the fixed dev identity")
        eku=extension("extendedKeyUsage")
        if "TLS Web Server Authentication" not in eku:raise ValueError("server authentication EKU required")
        # Trusted exact leaf still undergoes hostname, validity and server-purpose checks.
        command(["openssl","verify","-trusted",str(leaf),"-partial_chain","-purpose","sslserver",
                 "-verify_hostname",HOST,
                 *(["-attime",str(int(time.time() if now is None else now))] if check_time else ["-no_check_time"]),str(leaf)])
    return der

def database(home):
    old=home/".pki/nssdb"
    path=old if old.exists() else home/".local/share/pki/nssdb"
    if path.is_symlink() or not path.is_dir() or path.stat().st_uid!=os.geteuid() or path.stat().st_mode&0o022:
        raise ValueError("existing user-owned NSS database required")
    if any(parent.is_symlink() for parent in [path, *path.parents]):
        raise ValueError("symlink NSS path rejected")
    if (path/"cert9.db").is_symlink() or not (path/"cert9.db").is_file():raise ValueError("existing NSS SQL certificate database required")
    return path

def installed(certutil,db,nickname,der,run=command):
    listing=run([certutil,"-L","-d","sql:"+str(db)],text=True)
    parsed=[line.split() for line in listing.splitlines() if line.split()]
    if any(parts[0].startswith(PREFIX) and parts[0]!=nickname for parts in parsed):
        raise ValueError("stale managed dev leaf enrollment requires explicit reviewed removal")
    lines=[parts for parts in parsed if parts[0]==nickname]
    if not lines:return False
    if len(lines)!=1 or lines[0][-1]!="P,,":raise ValueError("existing enrollment has unexpected trust flags")
    if run([certutil,"-L","-d","sql:"+str(db),"-n",nickname,"-r"])!=der:
        raise ValueError("existing nickname has a different certificate")
    return True

def enroll(certutil,db,nickname,pem,der,run=command):
    if installed(certutil,db,nickname,der,run):return
    with tempfile.TemporaryDirectory(prefix="agent-trace-dev-leaf-") as temporary:
        leaf=Path(temporary)/"leaf.pem";leaf.write_bytes(pem)
        run([certutil,"-A","-d","sql:"+str(db),"-n",nickname,"-t","P,,","-i",str(leaf)])
    if not installed(certutil,db,nickname,der,run):raise ValueError("leaf enrollment readback failed")


def remove(certutil, db, nickname, der, run=command):
    if not installed(certutil, db, nickname, der, run):
        return
    run([certutil,"-D","-d","sql:"+str(db),"-n",nickname])
    if installed(certutil, db, nickname, der, run):
        raise ValueError("managed leaf removal readback failed")


def live_certificate_matches(pem, der):
    # Standard hostname/expiry verification with this exact non-CA peer anchor.
    # No HTTP, cookies or application requests are sent.
    import socket
    context=ssl.create_default_context(cadata=pem.decode("ascii"))
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    with socket.create_connection((HOST,3582),timeout=5) as raw:
        with context.wrap_socket(raw,server_hostname=HOST) as conn:
            if conn.getpeercert(binary_form=True)!=der:
                raise ValueError("live claimant leaf differs from reviewed exact leaf")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["preflight","install","remove"])
    parser.add_argument("--probe",action="store_true",help="Verify fixed3582 live TLS leaf without HTTP")
    args=parser.parse_args()
    if not sys.platform.startswith("linux") or os.geteuid()==0:
        raise ValueError("run as the shared Chrome Linux OS user, never root")
    if CERTIFICATE.is_symlink() or not CERTIFICATE.is_file():
        raise ValueError("reviewed regular public leaf required")
    pem=CERTIFICATE.read_bytes()
    der=validate_leaf(pem,PIN,check_time=args.mode!="remove")
    certutil=shutil.which("certutil")
    if certutil is None:raise ValueError("NSS certutil unavailable")
    db=database(Path(pwd.getpwuid(os.geteuid()).pw_dir))
    before=installed(certutil,db,NICKNAME,der)
    if args.mode=="install" or args.probe:
        live_certificate_matches(pem,der)
    if args.mode=="install":enroll(certutil,db,NICKNAME,pem,der)
    if args.mode=="remove":remove(certutil,db,NICKNAME,der)
    print(json.dumps({"origin":"https://"+HOST+":3582","certificate_sha256":PIN,
        "trust":"P,,","scope":"OS-user NSS; exact leaf, not port-specific",
        "previously_installed":before,"installed":installed(certutil,db,NICKNAME,der),
        "live_leaf_verified":args.mode=="install" or args.probe,"browser_qualified":False}))

if __name__=="__main__":
    try:main()
    except (ValueError,OSError,subprocess.SubprocessError):
        print("claimant leaf trust operation failed closed",file=sys.stderr)
        raise SystemExit(1)
