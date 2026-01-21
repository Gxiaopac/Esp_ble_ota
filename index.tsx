import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Bluetooth, BluetoothOff, FileUp, Play, CheckCircle, 
  AlertCircle, Terminal, RefreshCw, Cpu, ShieldCheck, 
  Settings, Zap, ChevronRight, Activity, HardDrive, 
  History, Info, X
} from 'lucide-react';

// --- Constants & BLE Specs ---
const UUIDS = {
  SERVICE: '00008018-0000-1000-8000-00805f9b34fb',
  DATA: '00008020-0000-1000-8000-00805f9b34fb',
  CMD: '00008022-0000-1000-8000-00805f9b34fb',
};
const SECTOR_SIZE = 4096;

const App = () => {
  // Refs
  const ble = useRef<{
    device: any;
    dataChar: any;
    cmdChar: any;
  } | null>(null);
  const ackResolvers = useRef<{ [key: string]: (status: number) => void }>({});

  // UI State
  const [connStatus, setConnStatus] = useState<'idle' | 'busy' | 'ready'>('idle');
  const [otaStatus, setOtaStatus] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [deviceName, setDeviceName] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{msg: string, type: string}[]>([]);
  const [fastMode, setFastMode] = useState(() => localStorage.getItem('ota_fast_mode') === 'true');
  const [showLogs, setShowLogs] = useState(false);

  // App Initialize
  useEffect(() => {
    localStorage.setItem('ota_fast_mode', String(fastMode));
  }, [fastMode]);

  // Haptic Feedback Helper
  const haptic = (type: 'success' | 'error' | 'click') => {
    if (!navigator.vibrate) return;
    if (type === 'success') navigator.vibrate([50, 30, 50]);
    if (type === 'error') navigator.vibrate([100, 50, 100]);
    if (type === 'click') navigator.vibrate(10);
  };

  const addLog = useCallback((msg: string, type: string = 'info') => {
    setLogs(prev => [{ msg, type }, ...prev.slice(0, 30)]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // --- BLE Handlers ---
  const handleAck = (event: any, prefix: string) => {
    const v = event.target.value as DataView;
    if (prefix === 'cmd') {
      const ackType = v.getUint16(0, true);
      const originalCmd = v.getUint16(2, true);
      const status = v.getUint16(4, true);
      if (ackType === 0x0003 && ackResolvers.current[`cmd_${originalCmd}`]) {
        ackResolvers.current[`cmd_${originalCmd}`](status);
      }
    } else {
      const sector = v.getUint16(0, true);
      const status = v.getUint16(2, true);
      if (ackResolvers.current[`sector_${sector}`]) {
        ackResolvers.current[`sector_${sector}`](status);
      }
    }
  };

  const connect = async () => {
    haptic('click');
    try {
      setConnStatus('busy');
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [UUIDS.SERVICE] }],
        optionalServices: [UUIDS.SERVICE]
      });

      addLog(`Pairing with ${device.name}...`);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(UUIDS.SERVICE);
      const dataChar = await service.getCharacteristic(UUIDS.DATA);
      const cmdChar = await service.getCharacteristic(UUIDS.CMD);

      await cmdChar.startNotifications();
      cmdChar.addEventListener('characteristicvaluechanged', (e: any) => handleAck(e, 'cmd'));
      await dataChar.startNotifications();
      dataChar.addEventListener('characteristicvaluechanged', (e: any) => handleAck(e, 'sector'));

      device.addEventListener('gattserverdisconnected', () => {
        setConnStatus('idle');
        setOtaStatus('idle');
        haptic('error');
      });

      ble.current = { device, dataChar, cmdChar };
      setDeviceName(device.name);
      setConnStatus('ready');
      haptic('success');
      addLog('System Ready', 'success');
    } catch (e: any) {
      setConnStatus('idle');
      addLog('Auth failed: ' + e.message, 'error');
    }
  };

  const runOta = async () => {
    if (!file || !ble.current) return;
    haptic('click');
    setOtaStatus('running');
    setProgress(0);

    const wait = (key: string) => new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error('ACK Timeout')), 12000);
      ackResolvers.current[key] = (s) => { clearTimeout(t); res(s); };
    });

    try {
      const startBuf = new ArrayBuffer(6);
      const dv = new DataView(startBuf);
      dv.setUint16(0, 0x0001, true);
      dv.setUint32(2, file.size, true);
      await ble.current.cmdChar.writeValueWithResponse(startBuf);
      if (await wait('cmd_1') !== 0) throw new Error('Rejected');

      const raw = new Uint8Array(await file.arrayBuffer());
      const totalS = Math.ceil(raw.length / SECTOR_SIZE);
      const pSize = fastMode ? 244 : 20;

      for (let s = 0; s < totalS; s++) {
        const sData = raw.slice(s * SECTOR_SIZE, (s + 1) * SECTOR_SIZE);
        const pkts = Math.ceil(sData.length / pSize);
        
        for (let p = 0; p < pkts; p++) {
          const chunk = sData.slice(p * pSize, (p + 1) * pSize);
          const pBuf = new Uint8Array(3 + chunk.length);
          const pdv = new DataView(pBuf.buffer);
          pdv.setUint16(0, s, true);
          pdv.setUint8(2, p === pkts - 1 ? 0xFF : p);
          pBuf.set(chunk, 3);
          await ble.current.dataChar.writeValueWithoutResponse(pBuf);
          if (!fastMode) await new Promise(r => setTimeout(r, 12));
        }
        if (await wait(`sector_${s}`) !== 0) throw new Error('Sector Error');
        setProgress(Math.round(((s + 1) / totalS) * 100));
      }

      await ble.current.cmdChar.writeValueWithResponse(new Uint8Array([0x02, 0x00]));
      await wait('cmd_2');
      setOtaStatus('success');
      haptic('success');
    } catch (e: any) {
      setOtaStatus('failed');
      addLog('Error: ' + e.message, 'error');
      haptic('error');
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 pb-12 max-w-lg mx-auto w-full overflow-hidden">
      <div className="flex items-center justify-between mb-8 mt-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-2">
            OTA <span className="text-blue-500">PRO</span>
          </h1>
          <p className="text-slate-400 text-xs font-semibold uppercase tracking-widest mt-1">IoT Deployment Tool</p>
        </div>
        <button 
          onClick={() => setShowLogs(!showLogs)}
          className={`p-3 rounded-2xl transition-all ${showLogs ? 'bg-blue-600 text-white' : 'glass-card text-slate-400'}`}
        >
          <Terminal size={20} />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto no-scrollbar pb-6">
        <div className={`glass-card rounded-[2.5rem] p-7 transition-all duration-500 ${connStatus === 'ready' ? 'ring-2 ring-blue-500/20' : ''}`}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className={`p-4 rounded-2xl ${connStatus === 'ready' ? 'bg-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]' : 'bg-slate-800'}`}>
                <Bluetooth className="text-white" size={24} />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase tracking-tighter">Device Status</p>
                <h3 className="text-lg font-bold text-slate-100 truncate w-32 md:w-48">
                  {connStatus === 'ready' ? deviceName : connStatus === 'busy' ? 'Searching...' : 'Disconnected'}
                </h3>
              </div>
            </div>
          </div>
          <button 
            onClick={connStatus === 'ready' ? () => ble.current?.device.gatt.disconnect() : connect}
            disabled={otaStatus === 'running'}
            className={`w-full py-5 rounded-[1.5rem] font-bold text-sm uppercase tracking-widest transition-all active:scale-95 ${connStatus === 'ready' ? 'bg-slate-800 text-slate-300' : 'bg-blue-600 text-white shadow-xl shadow-blue-500/20'}`}
          >
            {connStatus === 'ready' ? 'Terminate Link' : 'Pair New Device'}
          </button>
        </div>

        <div className="glass-card rounded-[2.5rem] p-7 space-y-6">
          <div className="flex items-center gap-4">
            <div className="p-4 bg-slate-800 rounded-2xl">
              <HardDrive className="text-slate-400" size={24} />
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-tighter">Firmware Image</p>
              <div className="relative">
                <input 
                  type="file" accept=".bin" className="absolute inset-0 opacity-0 cursor-pointer"
                  onChange={e => setFile(e.target.files?.[0] || null)}
                  disabled={otaStatus === 'running'}
                />
                <h3 className="text-lg font-bold text-blue-400 truncate">
                  {file ? file.name : 'Select .bin file'}
                </h3>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-900/50 rounded-2xl border border-white/5">
            <div className="flex items-center gap-3">
              <Zap className={fastMode ? 'text-yellow-400' : 'text-slate-600'} size={18} />
              <span className="text-xs font-bold text-slate-300">Fast MTU Mode</span>
            </div>
            <button 
              onClick={() => setFastMode(!fastMode)}
              className={`w-12 h-6 rounded-full transition-colors relative ${fastMode ? 'bg-blue-600' : 'bg-slate-700'}`}
            >
              <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${fastMode ? 'translate-x-6' : ''}`} />
            </button>
          </div>

          <button 
            onClick={runOta}
            disabled={!file || connStatus !== 'ready' || otaStatus === 'running'}
            className="w-full py-5 bg-white text-slate-900 rounded-[1.5rem] font-black text-sm uppercase tracking-widest transition-all active:scale-95 disabled:opacity-30 flex items-center justify-center gap-3"
          >
            {otaStatus === 'running' ? <RefreshCw className="animate-spin" size={18} /> : <Play size={18} />}
            {otaStatus === 'success' ? 'Update Again' : 'Deploy Firmware'}
          </button>
        </div>

        {otaStatus !== 'idle' && (
          <div className="glass-card rounded-[2.5rem] p-7 animate-in fade-in zoom-in-95">
            <div className="flex items-end justify-between mb-4">
              <div>
                <p className="text-xs font-bold text-slate-500 uppercase mb-1">Upload Progress</p>
                <h4 className={`text-xl font-black ${otaStatus === 'success' ? 'text-green-400' : otaStatus === 'failed' ? 'text-red-400' : 'text-white'}`}>
                  {otaStatus === 'success' ? 'DEPLOYED' : otaStatus === 'failed' ? 'FAILED' : `${progress}%`}
                </h4>
              </div>
              <Activity className={`${otaStatus === 'running' ? 'text-blue-500 animate-pulse' : 'text-slate-700'}`} size={24} />
            </div>
            <div className="h-4 bg-slate-900 rounded-full overflow-hidden border border-white/5">
              <div 
                className={`h-full progress-shimmer transition-all duration-300 rounded-full ${otaStatus === 'success' ? 'bg-green-500' : otaStatus === 'failed' ? 'bg-red-500' : ''}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {showLogs && (
        <div className="absolute inset-0 z-50 bg-slate-950/95 p-6 flex flex-col animate-in slide-in-from-bottom">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-black text-slate-500 uppercase tracking-[0.2em]">Debug Console</h2>
            <button onClick={() => setShowLogs(false)} className="p-2 text-slate-400"><X size={24}/></button>
          </div>
          <div className="flex-1 overflow-y-auto mono text-[10px] space-y-2 p-4 bg-black/40 rounded-3xl border border-white/5">
            {logs.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="text-slate-700 shrink-0">#{(logs.length - i).toString().padStart(2, '0')}</span>
                <span className={l.type === 'error' ? 'text-red-400' : l.type === 'success' ? 'text-emerald-400' : 'text-blue-300'}>
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
          <button onClick={clearLogs} className="mt-6 py-4 text-xs font-bold text-slate-500 uppercase">Clear Records</button>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 h-20 glass-card border-t border-white/5 flex items-center justify-around px-8 rounded-t-[2rem]">
        <button className="text-blue-500 flex flex-col items-center gap-1">
          <Cpu size={20} />
          <span className="text-[8px] font-bold uppercase tracking-tighter">Hardware</span>
        </button>
        <button className="text-slate-600 flex flex-col items-center gap-1">
          <History size={20} />
          <span className="text-[8px] font-bold uppercase tracking-tighter">History</span>
        </button>
        <button className="text-slate-600 flex flex-col items-center gap-1">
          <Settings size={20} />
          <span className="text-[8px] font-bold uppercase tracking-tighter">Config</span>
        </button>
      </div>
    </div>
  );
};

// Start initialization
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
