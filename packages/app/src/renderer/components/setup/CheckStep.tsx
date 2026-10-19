import { useApp } from '../../context';
import { useQuery } from '../../hooks';
import { Disclosure, ErrorBox, Loading } from '../ui';
import { CheckItem, DoctorBanner, severityOf } from '../DoctorChecks';

/** Step 1: `abox doctor`, the same checks as Settings > Diagnostics. Read-only; nothing here blocks the next step. */
export function CheckStep() {
  const { t } = useApp();
  const doctor = useQuery('doctor:run', undefined, { live: false });
  const data = doctor.data;
  const attention = data?.checks.filter((c) => ['warning', 'error'].includes(severityOf(c))) ?? [];
  const rest = data?.checks.filter((c) => !attention.includes(c)) ?? [];
  return (
    <>
      <p>{t('setup.check.intro')}</p>
      <div className="actions">
        <button type="button" onClick={() => void doctor.reload()} disabled={doctor.loading}>
          {t('setup.check.again')}
        </button>
      </div>
      {doctor.error ? <ErrorBox error={doctor.error} /> : null}
      {doctor.loading && !data ? <Loading /> : null}
      {data ? (
        <>
          <DoctorBanner report={data} />
          {attention.length > 0 ? (
            <>
              <h4 className="h-small">{t('setup.check.attention')}</h4>
              <ul className="checks">
                {attention.map((c) => (
                  <CheckItem key={c.id} check={c} />
                ))}
              </ul>
              <p className="muted">{t('setup.check.continue')}</p>
            </>
          ) : null}
          {rest.length > 0 ? (
            <Disclosure label={t('setup.check.rest', { count: rest.length })}>
              <ul className="checks">
                {rest.map((c) => (
                  <CheckItem key={c.id} check={c} />
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </>
      ) : null}
    </>
  );
}
