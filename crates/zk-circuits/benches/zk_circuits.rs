use criterion::{criterion_group, criterion_main, Criterion};
use owl_zk_circuits::{age_range, get_pk, get_pvk, kyc_status, nationality, ZkProofType};

fn bench_age_range(c: &mut Criterion) {
    let mut group = c.benchmark_group("age_range");

    let pk = get_pk(&ZkProofType::AgeRange);
    let pvk = get_pvk(&ZkProofType::AgeRange);

    group.bench_function("prove", |b| {
        b.iter(|| {
            age_range::prove(pk, 25, 18).expect("age_range prove failed");
        });
    });

    let proof = age_range::prove(pk, 25, 18).expect("age_range prove failed");
    group.bench_function("verify", |b| {
        b.iter(|| {
            age_range::verify(pvk, &proof).expect("age_range verify failed");
        });
    });

    group.finish();
}

fn bench_kyc_status(c: &mut Criterion) {
    let mut group = c.benchmark_group("kyc_status");

    let pk = get_pk(&ZkProofType::KycStatus);
    let pvk = get_pvk(&ZkProofType::KycStatus);

    group.bench_function("prove", |b| {
        b.iter(|| {
            kyc_status::prove(pk, 3, 2).expect("kyc_status prove failed");
        });
    });

    let proof = kyc_status::prove(pk, 3, 2).expect("kyc_status prove failed");
    group.bench_function("verify", |b| {
        b.iter(|| {
            kyc_status::verify(pvk, &proof).expect("kyc_status verify failed");
        });
    });

    group.finish();
}

fn bench_nationality(c: &mut Criterion) {
    let mut group = c.benchmark_group("nationality");

    let pk = get_pk(&ZkProofType::Nationality);
    let pvk = get_pvk(&ZkProofType::Nationality);
    let allowed: &[&str] = &["NL", "DE", "FR", "BE", "IT", "ES"];

    group.bench_function("prove", |b| {
        b.iter(|| {
            nationality::prove(pk, "NL", allowed).expect("nationality prove failed");
        });
    });

    let proof = nationality::prove(pk, "NL", allowed).expect("nationality prove failed");
    group.bench_function("verify", |b| {
        b.iter(|| {
            nationality::verify(pvk, &proof).expect("nationality verify failed");
        });
    });

    group.finish();
}

criterion_group!(benches, bench_age_range, bench_kyc_status, bench_nationality);
criterion_main!(benches);
