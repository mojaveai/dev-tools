import importlib.util
from pathlib import Path
import tempfile
import unittest
import subprocess
import shutil
import os
spec=importlib.util.spec_from_file_location('trust',Path(__file__).parents[1]/'claimant-leaf-trust.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
class Tests(unittest.TestCase):
    def test_actual_reviewed_leaf_identity_and_expiry(self):
        pem=t.CERTIFICATE.read_bytes()
        self.assertTrue(t.validate_leaf(pem,t.PIN))
        for pin,now in [('0'*64,None),(t.PIN,0),(t.PIN,2200000000)]:
            with self.assertRaises((ValueError,subprocess.SubprocessError)):t.validate_leaf(pem,pin,now)
        with self.assertRaises(ValueError):t.validate_leaf(pem+pem,t.PIN)
    def test_enrollment_readback_and_verified_removal(self):
        entries={};calls=[]
        def run(args,**kw):
            calls.append(args)
            if '-A' in args:
                self.assertEqual(args[args.index('-t')+1],'P,,');entries[t.NICKNAME]=b'der';return b''
            if '-D' in args:del entries[t.NICKNAME];return b''
            if '-r' in args:return entries[t.NICKNAME]
            return '\n'.join(k+' P,,' for k in entries)
        t.enroll('certutil',Path('/fixture'),t.NICKNAME,b'public',b'der',run)
        t.enroll('certutil',Path('/fixture'),t.NICKNAME,b'public',b'der',run)
        self.assertEqual(sum('-A' in c for c in calls),1)
        t.remove('certutil',Path('/fixture'),t.NICKNAME,b'der',run)
        self.assertEqual(entries,{})
    def test_conflicting_material_and_trust_reject_before_removal(self):
        for listing,der in [(t.NICKNAME+' CT,,',b'der'),(t.NICKNAME+' P,,',b'other'),(t.PREFIX+'old P,,',b'der')]:
            calls=[]
            def run(args,**kw):calls.append(args);return der if '-r' in args else listing
            with self.assertRaises(ValueError):t.remove('certutil',Path('/fixture'),t.NICKNAME,b'der',run)
            self.assertFalse(any('-D' in c for c in calls))
    def test_failed_readback_is_not_success(self):
        def run(args,**kw):return b'' if '-A' in args else ''
        with self.assertRaises(ValueError):t.enroll('certutil',Path('/fixture'),t.NICKNAME,b'public',b'der',run)
    def test_database_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            home=Path(root);target=home/'target';target.mkdir();(target/'cert9.db').touch()
            (home/'.pki').mkdir();(home/'.pki/nssdb').symlink_to(target)
            with self.assertRaises(ValueError):t.database(home)
    @unittest.skipUnless(os.environ.get('CLAIMANT_TEST_CERTUTIL'), 'explicit disposable NSS tool required')
    def test_real_disposable_nss_enroll_readback_conflict_and_remove(self):
        certutil=os.environ['CLAIMANT_TEST_CERTUTIL']
        pem=t.CERTIFICATE.read_bytes();der=t.validate_leaf(pem,t.PIN)
        with tempfile.TemporaryDirectory(prefix='claimant-nss-isolated-') as root:
            db=Path(root)/'nss';db.mkdir(mode=0o700)
            subprocess.run([certutil,'-N','-d','sql:'+str(db),'--empty-password'],check=True,capture_output=True)
            self.assertFalse(t.installed(certutil,db,t.NICKNAME,der))
            t.enroll(certutil,db,t.NICKNAME,pem,der)
            self.assertTrue(t.installed(certutil,db,t.NICKNAME,der))
            t.enroll(certutil,db,t.NICKNAME,pem,der)
            listing=t.command([certutil,'-L','-d','sql:'+str(db)],text=True)
            self.assertEqual(listing.count(t.NICKNAME),1)
            subprocess.run([certutil,'-M','-d','sql:'+str(db),'-n',t.NICKNAME,'-t','CT,,'],check=True,capture_output=True)
            with self.assertRaises(ValueError):t.remove(certutil,db,t.NICKNAME,der)
            subprocess.run([certutil,'-M','-d','sql:'+str(db),'-n',t.NICKNAME,'-t','P,,'],check=True,capture_output=True)
            t.remove(certutil,db,t.NICKNAME,der)
            self.assertFalse(t.installed(certutil,db,t.NICKNAME,der))
            t.remove(certutil,db,t.NICKNAME,der)
if __name__=='__main__':unittest.main()
