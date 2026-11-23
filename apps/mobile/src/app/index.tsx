import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';

type Client = { id: string; name: string; contact: string };
type Service = { id: string; name: string; price_cents: number };
type Subscription = {
  id: string; client_name: string; service_name: string; due_on: string;
  price_cents: number; cancelled_at: number | null;
};
type Operator = { id: string; email: string; access_until: number; revoked_at: number | null };
type Dashboard = {
  role: 'admin' | 'operator'; clients: Client[]; services: Service[];
  subscriptions: Subscription[]; hasMore: boolean;
};
type Page = 'Suscripciones' | 'Clientes' | 'Servicios' | 'Operadores' | 'Comprobantes';
type ReceiptResult = { id?: string; status?: string; message?: string; error?: string };
const sessionKey = 'neversionDigitalSession';
const base = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/$/, '');
const money = (cents: number) => 'Q' + (cents / 100).toFixed(2);

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, token?: string, method = 'GET', data?: object): Promise<T> {
  if (!base) throw new Error('Configura la URL de la API en EXPO_PUBLIC_API_URL.');
  const response = await fetch(base + '/api/' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, result.error || 'No se pudo completar la solicitud.');
  return result as T;
}

function Field({ label, value, change, secret = false, keyboard = 'default' }: {
  label: string; value: string; change: (value: string) => void; secret?: boolean;
  keyboard?: 'default' | 'decimal-pad' | 'number-pad' | 'email-address';
}) {
  return <View style={styles.field}>
    <Text style={styles.caption}>{label}</Text>
    <TextInput accessibilityLabel={label} style={styles.input} value={value} onChangeText={change}
      autoCapitalize={keyboard === 'email-address' || secret ? 'none' : 'sentences'}
      keyboardType={keyboard} secureTextEntry={secret} />
  </View>;
}

function Action({ label, onPress, disabled = false, subtle = false }: {
  label: string; onPress: () => void; disabled?: boolean; subtle?: boolean;
}) {
  return <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
    style={[styles.button, subtle && styles.subtle, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, subtle && styles.subtleText]}>{label}</Text>
  </Pressable>;
}

export default function NeversionDigital() {
  const [token, setToken] = useState<string>();
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [page, setPage] = useState<Page>('Suscripciones');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [client, setClient] = useState('');
  const [service, setService] = useState('');
  const [due, setDue] = useState('');
  const [renewing, setRenewing] = useState<string>();
  const [operatorEmail, setOperatorEmail] = useState('');
  const [operatorPassword, setOperatorPassword] = useState('');
  const [days, setDays] = useState('7');
  const [receiptImage, setReceiptImage] = useState<ImagePicker.ImagePickerAsset>();
  const [receiptResult, setReceiptResult] = useState<ReceiptResult>();

  useEffect(() => {
    (async () => {
      const saved = await SecureStore.getItemAsync(sessionKey);
      if (saved) {
        setDashboard(await request<Dashboard>('dashboard', saved));
        setToken(saved);
      }
    })().catch(async (problem: unknown) => {
      if (problem instanceof ApiError && problem.status === 401) await SecureStore.deleteItemAsync(sessionKey);
      else setError(problem instanceof Error ? problem.message : 'No se pudo restaurar la sesión.');
    }).finally(() => setBusy(false));
  }, []);

  async function clearSession() {
    await SecureStore.deleteItemAsync(sessionKey);
    setToken(undefined);
    setDashboard(undefined);
    setOperators([]);
    setReceiptImage(undefined);
    setReceiptResult(undefined);
    setPage('Suscripciones');
    setOffset(0);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await work(); }
    catch (problem) {
      if (token && problem instanceof ApiError && problem.status === 401) await clearSession();
      setError(problem instanceof Error ? problem.message : 'No se pudo completar la solicitud.');
    } finally { setBusy(false); }
  }

  async function refresh(newOffset = offset) {
    setDashboard(await request<Dashboard>('dashboard?offset=' + newOffset, token));
    setOffset(newOffset);
  }

  async function refreshOperators() {
    setOperators((await request<{ operators: Operator[] }>('operators', token)).operators);
  }

  function choosePage(next: Page) {
    setName('');
    setDetail('');
    setRenewing(undefined);
    setDue('');
    setPage(next);
    setError('');
    if (next === 'Operadores') void run(refreshOperators);
  }

  const admin = dashboard?.role === 'admin';
  const pages: Page[] = admin ? ['Suscripciones', 'Clientes', 'Servicios', 'Comprobantes', 'Operadores'] :
    ['Suscripciones', 'Clientes', 'Servicios', 'Comprobantes'];

  return <SafeAreaView style={styles.shell}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.brand}>Neversion Digital</Text>
        {token && <Action label="Salir" disabled={busy} subtle onPress={() => void run(async () => {
          await request('logout', token, 'POST');
          await clearSession();
        })} />}
      </View>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!token || !dashboard ? <View style={styles.card}>
        <Text style={styles.title}>Iniciar sesión</Text>
        <Field label="Correo" value={login} change={setLogin} keyboard="email-address" />
        <Field label="Contraseña" value={password} change={setPassword} secret />
        <Action label={busy ? 'Conectando…' : 'Entrar'} disabled={busy} onPress={() => void run(async () => {
          const result = await request<{ token: string }>('login', undefined, 'POST', { email: login, password });
          const records = await request<Dashboard>('dashboard', result.token);
          await SecureStore.setItemAsync(sessionKey, result.token);
          setPassword('');
          setDashboard(records);
          setToken(result.token);
        })} />
      </View> : <>
        <View style={styles.tabs}>{pages.map((item) =>
          <Action key={item} label={item} subtle={page !== item} disabled={busy} onPress={() => choosePage(item)} />,
        )}</View>
        {page === 'Suscripciones' && <>
          {admin && !renewing && <View style={styles.card}>
            <Text style={styles.title}>Nueva suscripción</Text>
            <Text style={styles.caption}>Cliente</Text>
            <View style={styles.tabs}>{dashboard.clients.map((item) =>
              <Action key={item.id} label={item.name} subtle={item.id !== client} onPress={() => setClient(item.id)} />,
            )}</View>
            <Text style={styles.caption}>Servicio</Text>
            <View style={styles.tabs}>{dashboard.services.map((item) =>
              <Action key={item.id} label={item.name} subtle={item.id !== service} onPress={() => setService(item.id)} />,
            )}</View>
            {(!dashboard.clients.length || !dashboard.services.length) &&
              <Text style={styles.caption}>Agrega un cliente y un servicio para continuar.</Text>}
            <Field label="Vencimiento (AAAA-MM-DD)" value={due} change={setDue} />
            <Action label="Guardar suscripción" disabled={busy || !client || !service} onPress={() => void run(async () => {
              await request('subscriptions', token, 'POST', { clientId: client, serviceId: service, dueOn: due });
              setDue(''); await refresh(0);
            })} />
          </View>}
          {dashboard.subscriptions.length === 0 && <Text style={styles.caption}>Todavía no hay suscripciones.</Text>}
          {dashboard.subscriptions.map((item) => <View key={item.id} style={styles.card}>
            <Text style={styles.title}>{item.client_name}</Text>
            <Text style={styles.caption}>{item.service_name} · {money(item.price_cents)}</Text>
            <Text style={styles.caption}>{item.cancelled_at ? 'Cancelada' : 'Vence el ' + item.due_on}</Text>
            {admin && !item.cancelled_at && <View style={styles.tabs}>
              {renewing === item.id ? <>
                <Field label="Nuevo vencimiento (AAAA-MM-DD)" value={due} change={setDue} />
                <Action label="Confirmar renovación" disabled={busy} onPress={() => void run(async () => {
                  await request('subscriptions/' + item.id, token, 'PATCH', { action: 'renew', dueOn: due });
                  setRenewing(undefined); setDue(''); await refresh();
                })} />
                <Action label="Volver" subtle onPress={() => { setRenewing(undefined); setDue(''); }} />
              </> : <>
                <Action label="Renovar" subtle disabled={busy} onPress={() => { setDue(''); setRenewing(item.id); }} />
                <Action label="Cancelar suscripción" subtle disabled={busy} onPress={() => Alert.alert(
                  'Cancelar suscripción', item.client_name + ' · ' + item.service_name, [
                    { text: 'Volver', style: 'cancel' },
                    { text: 'Confirmar', style: 'destructive', onPress: () => void run(async () => {
                      await request('subscriptions/' + item.id, token, 'PATCH', { action: 'cancel' });
                      await refresh();
                    }) },
                  ],
                )} />
              </>}
            </View>}
          </View>)}
          <View style={styles.tabs}>
            {offset > 0 && <Action label="Anterior" subtle disabled={busy} onPress={() => void run(() => refresh(offset - 50))} />}
            {dashboard.hasMore && <Action label="Siguiente" subtle disabled={busy} onPress={() => void run(() => refresh(offset + 50))} />}
          </View>
        </>}
        {(page === 'Clientes' || page === 'Servicios') && <>
          {admin && <View style={styles.card}>
            <Text style={styles.title}>{page === 'Clientes' ? 'Nuevo cliente' : 'Nuevo servicio'}</Text>
            <Field label="Nombre" value={name} change={setName} />
            <Field label={page === 'Clientes' ? 'Contacto' : 'Precio en quetzales'} value={detail} change={setDetail}
              keyboard={page === 'Clientes' ? 'default' : 'decimal-pad'} />
            <Action label="Guardar" disabled={busy} onPress={() => void run(async () => {
              if (page === 'Clientes') await request('clients', token, 'POST', { name, contact: detail });
              else {
                const price = detail.trim().replace(',', '.');
                if (!/^\d+(\.\d{1,2})?$/.test(price)) throw new Error('Ingresa un precio válido.');
                await request('services', token, 'POST', { name, priceCents: Math.round(Number(price) * 100) });
              }
              setName(''); setDetail(''); await refresh();
            })} />
          </View>}
          {(page === 'Clientes' ? dashboard.clients : dashboard.services).map((item) =>
            <View key={item.id} style={styles.card}>
              <Text style={styles.title}>{item.name}</Text>
              <Text style={styles.caption}>{'contact' in item ? item.contact : money(item.price_cents)}</Text>
            </View>,
          )}
        </>}
        {page === 'Comprobantes' && <View style={styles.card}>
          <Text style={styles.title}>Validar comprobante</Text>
          <Action label={receiptImage ? 'Cambiar imagen' : 'Elegir imagen'} subtle disabled={busy}
            onPress={() => void run(async () => {
              const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
              if (picked.canceled) return;
              const selected = picked.assets[0];
              if (selected.fileSize && selected.fileSize > 5 * 1024 * 1024) {
                throw new Error('La imagen puede pesar hasta 5 MB.');
              }
              setReceiptImage(selected);
              setReceiptResult(undefined);
            })} />
          {!!receiptImage && <Text style={styles.caption}>{receiptImage.fileName ?? 'Imagen seleccionada'}</Text>}
          <Action label={busy ? 'Procesando…' : 'Validar imagen'} disabled={busy || !receiptImage}
            onPress={() => void run(async () => {
              if (!receiptImage) return;
              setReceiptResult(undefined);
              const form = new FormData();
              form.append('receipt', {
                uri: receiptImage.uri,
                name: receiptImage.fileName || 'comprobante',
                type: receiptImage.mimeType || 'application/octet-stream',
              } as unknown as Blob);
              const response = await fetch(base + '/api/receipts', {
                method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form,
              });
              const result: ReceiptResult = await response.json().catch(() => ({}));
              if (!result.status) {
                throw new ApiError(response.status, result.error || 'No se pudo validar el comprobante.');
              }
              setReceiptImage(undefined);
              setReceiptResult(result);
            })} />
          {!!receiptResult && <View accessibilityLiveRegion="polite">
            <Text style={styles.title}>{receiptResult.status === 'APPROVED' ? 'Validación aprobada' :
              receiptResult.status === 'REVIEW_REQUIRED' ? 'Requiere revisión' : 'Comprobante rechazado'}</Text>
            <Text style={styles.caption}>{receiptResult.message}</Text>
            {!!receiptResult.id && <Text style={styles.caption}>Referencia de revisión: {receiptResult.id}</Text>}
          </View>}
        </View>}
        {page === 'Operadores' && admin && <>
          <View style={styles.card}>
            <Text style={styles.title}>Crear o renovar acceso</Text>
            <Field label="Correo del operador" value={operatorEmail} change={setOperatorEmail} keyboard="email-address" />
            <Field label="Contraseña" value={operatorPassword} change={setOperatorPassword} secret />
            <Field label="Días de acceso" value={days} change={setDays} keyboard="number-pad" />
            <Action label="Guardar acceso" disabled={busy} onPress={() => void run(async () => {
              await request('operators', token, 'POST', { email: operatorEmail, password: operatorPassword, days: Number(days) });
              setOperatorEmail(''); setOperatorPassword(''); await refreshOperators();
            })} />
          </View>
          {operators.map((item) => <View key={item.id} style={styles.card}>
            <Text style={styles.title}>{item.email}</Text>
            <Text style={styles.caption}>{item.revoked_at ? 'Revocado' :
              'Acceso hasta ' + new Date(item.access_until * 1000).toLocaleString('es-GT')}</Text>
            {!item.revoked_at && <Action label="Revocar" disabled={busy} subtle onPress={() => void run(async () => {
              await request('operators/' + item.id, token, 'DELETE'); await refreshOperators();
            })} />}
          </View>)}
        </>}
      </>}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: '#0B101D' },
  content: { padding: 20, paddingBottom: 44, gap: 14, maxWidth: 720, width: '100%', alignSelf: 'center' },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginVertical: 8 },
  brand: { color: '#F8FAFF', fontSize: 27, fontWeight: '800', letterSpacing: -0.7 },
  card: { backgroundColor: '#151D2F', borderColor: '#27324A', borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 },
  title: { color: '#F0F5FF', fontSize: 18, fontWeight: '700' },
  caption: { color: '#BDCAE2', fontSize: 15, lineHeight: 22 },
  field: { gap: 5, minWidth: 148 },
  input: { backgroundColor: '#0B101D', color: '#F0F5FF', minHeight: 46, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: '#496080', fontSize: 16 },
  button: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: 8, paddingHorizontal: 13, backgroundColor: '#9CB9FF', borderRadius: 10 },
  buttonText: { color: '#0B101D', fontSize: 14, fontWeight: '700' },
  subtle: { backgroundColor: '#222D44' },
  subtleText: { color: '#E5EDFF' },
  disabled: { opacity: 0.5 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  error: { backgroundColor: '#412334', color: '#FFDCEA', padding: 12, borderRadius: 10, fontSize: 15 },
});
